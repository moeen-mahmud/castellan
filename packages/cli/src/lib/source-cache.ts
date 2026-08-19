/**
 * Fetching a source, and reading the skills out of it. The only place in the CLI that reaches a network.
 *
 * ## Git, and the two-minute hang that shaped this file
 *
 * `git ls-remote https://github.com/github/skills` — a repository that does not exist — did not fail.
 * It sat for two minutes waiting for a credential prompt on a terminal nobody was watching, because a
 * 404 on a private-or-absent repo is indistinguishable from "you are not logged in yet". So every
 * invocation here runs with prompting switched off in all four ways git can be asked
 * (`GIT_TERMINAL_PROMPT`, `GIT_ASKPASS`, `SSH_ASKPASS`, `BatchMode`) **and** under a wall-clock
 * timeout. A command that cannot fail is worse than one that fails slowly.
 *
 * The user's own git config is deliberately left alone — `GIT_CONFIG_NOSYSTEM` would drop the
 * credential helper, which is exactly how a private source is meant to work.
 *
 * ## Blobless and sparse, measured
 *
 * `git clone --depth 1 --single-branch --filter=blob:none --sparse` then `sparse-checkout set <path>`.
 * On `github/awesome-copilot`: 100 MB of repository becomes 22 MB on disk in 9 s, with all 425 skills
 * present. A plain shallow clone of the same repo is the full 100 MB, for the same 425 files. The
 * filter is refused by some servers, so a failure retries without it rather than reporting one.
 *
 * ## Update is re-clone, on purpose
 *
 * One code path instead of `fetch` + `reset --hard` + reconciling sparse state, and one thing that
 * cannot happen: a cache in a half-updated shape nobody can reason about. Every fetch lands in
 * `<name>.partial` and is renamed into place only once it has worked, so an interrupted update leaves
 * the previous catalogue intact and searchable — and an interrupted *first* fetch leaves no directory
 * at all, rather than an empty repo that looks like a source with no skills in it.
 */

import { cacheDir, cacheRoot, type SourceSpec } from "#lib/sources"
import { spawnCaptureAsync } from "#lib/spawn"
import { estimateTokens, HarnessError, parseSkillFile } from "@dispach/core"
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { join, relative } from "node:path"

const SKILL_FILE = "SKILL.md"

/** Long enough for a 100 MB repository on a slow link; short enough to be a failure, not a hang. */
export const FETCH_TIMEOUT_MS = 180_000

export interface GitResult {
    readonly code: number
    readonly stdout: string
    readonly stderr: string
    /** True when the process was killed by the timeout rather than exiting on its own. */
    readonly timedOut?: boolean
}

/**
 * Injected by the tests, which never reach a network.
 *
 * Async, and that is load-bearing rather than stylistic: `spawnSync` inside a rendered screen freezes the
 * whole app — no spinner frame advances, and the keys pressed during a twenty-second clone are echoed by
 * the tty instead of being consumed, which is how `^[[B^[[A` was printed into a fetch progress line.
 */
export type Git = (args: readonly string[], cwd?: string) => Promise<GitResult>

export const realGit: Git = async (args, cwd) => {
    const result = await spawnCaptureAsync({
        command: "git",
        args,
        ...(cwd === undefined ? {} : { cwd }),
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: {
            ...process.env,
            // All four, because each covers a different way git asks for a credential and any one left
            // open is the hang described above. The user's own git config is untouched: dropping it would
            // drop the credential helper, which is exactly how a private source is meant to work.
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "",
            SSH_ASKPASS: "",
            SSH_ASKPASS_REQUIRE: "never",
            GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
        },
    })
    if (result.notFound) {
        throw new HarnessError({
            code: "git_missing",
            message: "git is not on PATH, and a skill source is a git repository",
            hint: "Install git — on macOS `xcode-select --install` is enough. Until then, clone a repository by hand and use `skills install <agent> <path>`.",
        })
    }
    return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.signalled ? { timedOut: true } : {}),
    }
}

/** One skill as it exists in a source, before anything is copied. */
export interface CatalogueEntry {
    readonly source: string
    /** The frontmatter `name`, which is what it will be installed as. */
    readonly skill: string
    /** Absolute path in the cache. */
    readonly dir: string
    /** Path inside the repository, recorded as provenance on install. */
    readonly repoPath: string
    readonly description: string
    readonly tokens: number
    /** Files that would run: an executable bit, or a script extension. A trust signal, not a count. */
    readonly scripts: readonly string[]
    /** Present when the folder holds a `SKILL.md` that will not load. Listed anyway, honestly. */
    readonly problem?: string
}

export interface SourceMeta {
    readonly commit?: string
    readonly fetchedAt?: string
    readonly skills?: number
}

function metaPath(name: string, env?: Readonly<Record<string, string | undefined>>): string {
    return join(cacheRoot(env), `${name}.json`)
}

export function readMeta(
    name: string,
    env?: Readonly<Record<string, string | undefined>>,
): SourceMeta {
    const path = metaPath(name, env)
    if (!existsSync(path)) return {}
    try {
        return JSON.parse(readFileSync(path, "utf8")) as SourceMeta
    } catch {
        // A corrupt meta file costs a "never fetched" line and nothing else; it is not worth failing
        // a listing over, and the next fetch overwrites it.
        return {}
    }
}

export function isCached(
    name: string,
    env?: Readonly<Record<string, string | undefined>>,
): boolean {
    return existsSync(join(cacheDir(name, env), ".git"))
}

/**
 * True when a skill reference should be read as a path on disk instead.
 *
 * Filesystem-first, which is git's pathspec rule and the one `resolveAgentRef` already follows. The three
 * prefixes are checked *before* existence so a mistyped `./skils/pdf` is reported as a missing directory
 * rather than as an unknown skill — the two failures have completely different remedies.
 */
export function looksLikePath(ref: string): boolean {
    return ref.startsWith(".") || ref.startsWith("/") || ref.startsWith("~") || existsSync(ref)
}

export interface FetchResult {
    readonly commit: string
    readonly skills: number
    /** True when the partial-clone filter was refused and a full shallow clone was used instead. */
    readonly unfiltered: boolean
}

/**
 * Clone or re-clone a source into the cache.
 *
 * Failure throws with git's own stderr attached: it is almost always the useful part — a wrong branch
 * name, a repository that needs credentials, a host that is down — and paraphrasing it would lose the
 * one sentence that says which.
 */
export async function fetchSource(
    spec: SourceSpec,
    options: {
        readonly env?: Readonly<Record<string, string | undefined>>
        readonly git?: Git
    } = {},
): Promise<FetchResult> {
    const git = options.git ?? realGit
    const env = options.env
    const target = cacheDir(spec.name, env)
    const partial = `${target}.partial`

    mkdirSync(cacheRoot(env), { recursive: true })
    rmSync(partial, { recursive: true, force: true })

    const base = [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        ...(spec.ref === undefined ? [] : ["--branch", spec.ref]),
    ]
    const sparse = spec.path !== undefined
    let unfiltered = !sparse
    let result = sparse
        ? await git([...base, "--filter=blob:none", "--sparse", spec.url, partial])
        : await git([...base, spec.url, partial])

    if (result.code !== 0 && sparse) {
        // Some servers refuse a partial clone. Retrying full is a bigger download, never a failure.
        rmSync(partial, { recursive: true, force: true })
        const retry = await git([...base, spec.url, partial])
        if (retry.code === 0) {
            unfiltered = true
            result = retry
        }
    }
    if (result.code !== 0) {
        rmSync(partial, { recursive: true, force: true })
        throw cloneFailed(spec, result)
    }

    if (spec.path !== undefined && !unfiltered) {
        const narrowed = await git(["sparse-checkout", "set", spec.path], partial)
        if (narrowed.code !== 0) {
            rmSync(partial, { recursive: true, force: true })
            throw new HarnessError({
                code: "skill_source_path_missing",
                message: `${spec.name}: could not narrow the checkout to ${spec.path}`,
                hint: `Check the path exists in ${spec.url}. ${narrowed.stderr.trim() || "git said nothing."}`,
            })
        }
    }

    const head = await git(["rev-parse", "--short", "HEAD"], partial)
    const commit = head.code === 0 ? head.stdout.trim() : "unknown"

    rmSync(target, { recursive: true, force: true })
    renameSync(partial, target)

    const skills = readCatalogue(spec, env).length
    writeFileSync(
        metaPath(spec.name, env),
        `${JSON.stringify({ commit, fetchedAt: new Date().toISOString(), skills }, null, 4)}\n`,
    )
    return { commit, skills, unfiltered }
}

function cloneFailed(spec: SourceSpec, result: GitResult): HarnessError {
    const said = result.stderr.trim().split("\n").slice(-3).join(" ")
    if (result.timedOut === true) {
        return new HarnessError({
            code: "skill_source_timeout",
            message: `${spec.name}: git did not finish within ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`,
            hint: `Check the network, then try again — a partly fetched source was discarded, so the previous copy of ${spec.name} is untouched.`,
        })
    }
    return new HarnessError({
        code: "skill_source_fetch_failed",
        message: `${spec.name}: could not clone ${spec.url}${said.length === 0 ? "" : ` — ${said}`}`,
        hint: "A private repository needs a credential helper git can use without prompting. Check the URL and the branch; `sources remove` drops a source you no longer want.",
    })
}

/** Depth from the scan root. Four covers `skills/<name>/`, a namespace level, and slack. */
const MAX_DEPTH = 4
const SKIPPED = new Set(["node_modules", "dist", "build", "target", "vendor", ".git"])

function skillDirs(root: string): string[] {
    const found: string[] = []
    const walk = (dir: string, depth: number): void => {
        if (depth > MAX_DEPTH) return
        let entries: readonly { name: string; isDirectory(): boolean }[]
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        // A skill folder is **not** a leaf, and assuming it was hid fifteen skills on the first real run.
        // `github/awesome-copilot` nests them: `skills/qdrant-scaling/SKILL.md` is a skill and so are the
        // four inside it, three levels deep in one case. Stopping here reported 410 of 425 with nothing
        // saying which were missing.
        //
        // The cost of descending is a false positive — a `references/SKILL.md` kept as an example would be
        // listed as a skill — and that is the cheaper mistake by a wide margin: it appears in a listing
        // where a person can see it, while a false negative is a skill that simply does not exist as far
        // as this tool is concerned. `parseSkillFile` filters most of it anyway, since the spec requires
        // `name` to equal the directory.
        if (existsSync(join(dir, SKILL_FILE))) found.push(dir)
        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue
            walk(join(dir, entry.name), depth + 1)
        }
    }
    walk(root, 0)
    return found.sort()
}

const SCRIPT_EXTENSIONS = [".py", ".sh", ".js", ".ts", ".mjs", ".rb", ".pl"]

/**
 * Files in a skill that would run if the model called them.
 *
 * Over-reports on purpose: a `.py` with no executable bit still runs under `python3`, and this is the
 * line a person reads before agreeing to install somebody else's folder. Under-reporting here is the
 * only failure that matters.
 */
function scriptsIn(dir: string, depth = 0): string[] {
    if (depth > 3) return []
    const found: string[] = []
    let entries: readonly { name: string; isDirectory(): boolean; isFile(): boolean }[]
    try {
        entries = readdirSync(dir, { withFileTypes: true })
    } catch {
        return []
    }
    for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
            if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue
            found.push(...scriptsIn(full, depth + 1))
            continue
        }
        if (!entry.isFile()) continue
        const executable = (statSync(full).mode & 0o111) !== 0
        if (executable || SCRIPT_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
            found.push(full)
        }
    }
    return found
}

/**
 * Every skill in a fetched source.
 *
 * Reads whole files rather than only frontmatter, because the token count is a property of the body and
 * it is the number that decides whether a skill can be installed at all. 425 skills is a few megabytes.
 */
export function readCatalogue(
    spec: SourceSpec,
    env?: Readonly<Record<string, string | undefined>>,
): readonly CatalogueEntry[] {
    const base = cacheDir(spec.name, env)
    const root = spec.path === undefined ? base : join(base, spec.path)
    if (!existsSync(root)) return []

    const entries: CatalogueEntry[] = []
    for (const dir of skillDirs(root)) {
        const raw = readFileSync(join(dir, SKILL_FILE), "utf8")
        const folder = dir.slice(dir.lastIndexOf("/") + 1)
        const shared = {
            source: spec.name,
            dir,
            repoPath: relative(base, dir),
            scripts: scriptsIn(dir),
        }
        try {
            const parsed = parseSkillFile(folder, raw)
            entries.push({
                ...shared,
                skill: parsed.frontmatter.name,
                description: parsed.frontmatter.description,
                tokens: estimateTokens(parsed.body),
            })
        } catch (error) {
            // Listed with its problem rather than dropped — the same rule the sandbox listing follows.
            // A skill that will not load is information; a skill that silently is not there is a
            // filesystem investigation.
            entries.push({
                ...shared,
                skill: folder,
                description: "",
                tokens: estimateTokens(raw),
                problem: error instanceof Error ? error.message : String(error),
            })
        }
    }
    return entries
}
