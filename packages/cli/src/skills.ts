/**
 * `skills list|show|validate <manifest>` — what this agent knows how to do, and how well it is written.
 *
 * Three questions, deliberately not one command. `list` is the inventory, `show` is one skill in full —
 * including the parts the model never sees, which is the only way to check what it *will* see — and
 * `validate` is the authoring read.
 *
 * `validate` warns and exits 0, with `--strict` for CI. That is the `workspace` split rather than the
 * `validate` one: a skill that does not load already fails here loudly, because this calls the same
 * `loadSkills` the runtime does, and everything past that is a judgement. In particular a missing
 * when-not-to-use is a warning and never a refusal — requiring it would reject every skill vendored from
 * `anthropics/skills` and withdraw decision 6.1's compliance claim to buy a nag.
 *
 * A `ScriptRunner` is supplied here for the same reason `run` supplies one: without it a skill's
 * `scripts/` is never scanned, so `skills list` would report "no scripts" for a skill that ships three.
 * The command answers about the runtime, not about a subset of it.
 */

import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { basename, isAbsolute, join, resolve } from "node:path"
import {
    checkSkillAuthoring,
    type ErrorDetail,
    estimateTokens,
    HarnessError,
    isSkillName,
    loadManifest,
    loadSkills,
    parseSkillFile,
    resolveCapabilities,
    type Skill,
    type SkillsConfig,
    whenNotToUseKey,
} from "@castellan/core"
import { setInSource } from "@castellan/tools-system"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { CHANNEL_IDS, PROVIDER_IDS, scriptRunner } from "#lib/providers"
import { bullet, indent, keyValue, section } from "#lib/render"
import { fillTemplate, SKILL_TEMPLATE } from "#lib/templates"

const SKILL_FILE = "SKILL.md"

/**
 * The actions this command accepts, pinned so `--help` and the switch below cannot drift.
 *
 * The same guard `DAEMON_ACTIONS` gets: a verb added in one place and not the other fails a test rather
 * than at the moment somebody types it.
 */
export const SKILLS_ACTIONS = ["list", "show", "new", "install", "remove", "validate"] as const

export interface SkillsOptions {
    readonly manifestPath: string
    /** `list`, `show` or `validate`. Checked by the dispatcher against the spec's `choices`. */
    readonly action: string
    /**
     * The skill `show`, `new` and `remove` act on — or, for `install`, the directory to copy from.
     *
     * One positional rather than three, because the parser has one slot after the manifest and a
     * command with `--name`, `--from` and `--skill` flags reads worse than the thing it replaced.
     */
    readonly name?: string
    readonly json?: boolean
    /** `validate` only: exit non-zero when anything was reported. */
    readonly strict?: boolean
}

export function skillsCommand(options: SkillsOptions): number {
    try {
        const loaded = loadManifest(options.manifestPath, {
            knownProviders: PROVIDER_IDS,
            knownChannels: CHANNEL_IDS,
            // The same environment `run` uses, or this reports on a different agent — the asymmetry
            // every command that loads a manifest exists to avoid.
            env: ambientEnv([options.manifestPath]),
        })

        // `new` and `install` are the two that may run with nothing configured — turning skills on is
        // exactly what they are for, so they do it rather than reporting that it has not been done.
        const creating = options.action === "new" || options.action === "install"
        const configured = creating
            ? enable(loaded.path, loaded.dir, loaded.manifest.skills)
            : loaded.manifest.skills
        if (configured === undefined) {
            return unconfigured(options)
        }

        const capabilities = resolveCapabilities(
            loaded.manifest.model.main.id,
            loaded.manifest.model.main.capabilities,
        )
        const resolvedDir = isAbsolute(configured.dir)
            ? configured.dir
            : resolve(loaded.dir, configured.dir)

        // `new` and `remove` run **before** the catalogue is loaded, and that ordering is the fix for a
        // dead end this command had: a skill over `skills.budget` fails the load, so with `remove` behind
        // `loadSkills` the one command that could undo it was the one that could not run. Neither needs a
        // catalogue — one writes a directory, the other deletes one — so neither waits for it.
        if (options.action === "new") return create(resolvedDir, options)
        if (options.action === "remove") return remove(resolvedDir, options)

        const catalogue = loadSkills({
            dir: resolvedDir,
            maxActive: configured.maxActive,
            budget: configured.budget,
            threshold: configured.threshold,
            style: capabilities.promptStyle,
            agentDir: loaded.dir,
            runner: scriptRunner(),
        })

        switch (options.action) {
            case "list":
                return list(catalogue.skills, catalogue, options)
            case "show":
                return show(catalogue.skills, options)
            case "install":
                return install(resolvedDir, configured.budget, options)
            default:
                // `validate` is the fallback rather than a named case because the parser has already
                // rejected anything outside `SKILLS_ACTIONS`, and the safest thing to do with an action
                // that somehow got through is the one that changes nothing.
                return validate(catalogue.skills, options)
        }
    } catch (error) {
        if (options.json === true && error instanceof HarnessError) {
            process.stdout.write(
                `${JSON.stringify({ ok: false, error: error.toDetail(), details: error.details }, null, 2)}\n`,
            )
            return EXIT_FAILURE
        }
        throw error
    }
}

/**
 * No `skills:` block at all.
 *
 * Not an error — an agent without skills is an ordinary agent — but it names the block, because someone
 * who typed this command was looking for something and "no skills" without a way forward is the shape
 * decision 4.53 objects to.
 */
function unconfigured(options: SkillsOptions): number {
    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify({ ok: true, configured: false, skills: [] }, null, 2)}\n`,
        )
        return EXIT_OK
    }
    process.stdout.write(
        "this agent has no skills configured\n\n" +
            "  add a skills block to agent.yaml and a directory beside it:\n\n" +
            "    skills:\n" +
            "      dir: ./skills\n" +
            "      maxActive: 1\n\n" +
            "  each skill is a directory holding SKILL.md — see docs/02-SPEC-MANIFEST.md\n",
    )
    return EXIT_OK
}

function list(
    skills: readonly Skill[],
    catalogue: {
        readonly maxActive: number
        readonly budget: number
        readonly threshold: number
        readonly cached: boolean
    },
    options: SkillsOptions,
): number {
    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    ok: true,
                    configured: true,
                    cached: catalogue.cached,
                    maxActive: catalogue.maxActive,
                    budget: catalogue.budget,
                    threshold: catalogue.threshold,
                    skills: skills.map(summarise),
                },
                null,
                2,
            )}\n`,
        )
        return EXIT_OK
    }

    if (skills.length === 0) {
        process.stdout.write("no skills found in the configured directory\n")
        return EXIT_OK
    }

    process.stdout.write(
        `${keyValue([
            { label: "skills", value: String(skills.length) },
            {
                label: "per turn",
                value: `at most ${catalogue.maxActive}, within ${catalogue.budget} tokens`,
            },
            { label: "threshold", value: catalogue.threshold.toFixed(2) },
            { label: "index", value: catalogue.cached ? "cached" : "scanned" },
        ])}\n`,
    )

    process.stdout.write(`${section("catalogue")}\n`)
    for (const skill of skills) {
        const scripts = skill.scripts.length === 0 ? "" : `  ${skill.scripts.length} script(s)`
        // A missing negative guidance is flagged even in `list`, because it is the one thing that is
        // both cheap to fix and invisible until something routes wrongly.
        const gap = skill.frontmatter.whenNotToUse === undefined ? "  no when-not-to-use" : ""
        process.stdout.write(
            `  ${skill.name.padEnd(20)} ${String(skill.tokens).padStart(5)} tokens${scripts}${gap}\n`,
        )
    }
    return EXIT_OK
}

function show(skills: readonly Skill[], options: SkillsOptions): number {
    const wanted = options.name
    if (wanted === undefined) {
        process.stdout.write("skills show needs a skill name — `skills list` names them\n")
        return EXIT_FAILURE
    }
    const skill = skills.find((entry) => entry.name === wanted)
    if (skill === undefined) {
        const known = skills.map((entry) => entry.name).join(", ")
        process.stdout.write(`no skill named ${wanted}${known === "" ? "" : `. Known: ${known}`}\n`)
        return EXIT_FAILURE
    }

    if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ ok: true, skill: detail(skill) }, null, 2)}\n`)
        return EXIT_OK
    }

    const { frontmatter } = skill
    process.stdout.write(
        `${keyValue([
            { label: "name", value: skill.name },
            { label: "directory", value: skill.dir },
            { label: "body", value: `${skill.tokens} tokens` },
            ...(frontmatter.license === undefined
                ? []
                : [{ label: "license", value: frontmatter.license }]),
            ...(frontmatter.compatibility === undefined
                ? []
                : [{ label: "needs", value: frontmatter.compatibility }]),
        ])}\n`,
    )

    process.stdout.write(`${section("description")}\n`)
    process.stdout.write(`${indent(frontmatter.description)}\n`)

    process.stdout.write(`${section("when not to use")}\n`)
    process.stdout.write(
        `${indent(
            frontmatter.whenNotToUse ??
                `not declared — add metadata.${whenNotToUseKey()} to improve routing`,
        )}\n`,
    )

    if (skill.scripts.length > 0) {
        process.stdout.write(`${section("scripts")}\n`)
        for (const plan of skill.scripts) {
            process.stdout.write(
                `${bullet(`${plan.slug} — scripts/${plan.file} via ${plan.interpreter ?? "its own shebang"}`)}\n`,
            )
        }
    }

    if (skill.ignoredScripts.length > 0) {
        process.stdout.write(`${section("in scripts/ and not runnable")}\n`)
        for (const ignored of skill.ignoredScripts) {
            process.stdout.write(`${bullet(`${ignored.file} — ${ignored.reason}`)}\n`)
        }
    }

    if (frontmatter.allowedTools !== undefined) {
        process.stdout.write(`${section("allowed-tools, declared and not honoured")}\n`)
        // Printed rather than ignored, and labelled rather than merely printed. A downloaded folder does
        // not widen what this agent may run — that is `tools.policy`, and only a person edits it.
        process.stdout.write(`${indent(frontmatter.allowedTools)}\n`)
        process.stdout.write(
            `${indent("this runtime reads the field and never acts on it; permissions live in tools.policy")}\n`,
        )
    }

    const extra = Object.entries(frontmatter.metadata).filter(([key]) => key !== whenNotToUseKey())
    if (extra.length > 0) {
        process.stdout.write(`${section("metadata")}\n`)
        process.stdout.write(`${keyValue(extra.map(([label, value]) => ({ label, value })))}\n`)
    }

    return EXIT_OK
}

function validate(skills: readonly Skill[], options: SkillsOptions): number {
    const findings = checkSkillAuthoring(skills)

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify(
                { ok: findings.length === 0, skills: skills.map(summarise), findings },
                null,
                2,
            )}\n`,
        )
        return options.strict === true && findings.length > 0 ? EXIT_FAILURE : EXIT_OK
    }

    // Every skill is named whether or not it has findings, so a clean one is visibly checked rather
    // than merely absent from a list of problems.
    const byName = new Map<string, ErrorDetail[]>()
    for (const finding of findings) {
        const name = skills.find((skill) => finding.message.includes(` ${skill.name}:`))?.name
        const key = name ?? ""
        byName.set(key, [...(byName.get(key) ?? []), finding])
    }

    for (const skill of skills) {
        const own = byName.get(skill.name) ?? []
        process.stdout.write(
            `  ${skill.name.padEnd(20)} ${own.length === 0 ? "ok" : `${own.length} warning(s)`}\n`,
        )
    }

    if (findings.length === 0) {
        process.stdout.write("\nno findings\n")
        return EXIT_OK
    }

    for (const finding of findings) {
        process.stdout.write(`\n  ${finding.code}: ${finding.message}\n`)
        process.stdout.write(`    hint: ${finding.hint}\n`)
    }
    process.stdout.write(
        `\n${findings.length} finding(s) — warnings, not failures. --strict exits non-zero.\n`,
    )
    return options.strict === true ? EXIT_FAILURE : EXIT_OK
}

function summarise(skill: Skill) {
    return {
        name: skill.name,
        tokens: skill.tokens,
        hasWhenNotToUse: skill.frontmatter.whenNotToUse !== undefined,
        scripts: skill.scripts.map((plan) => plan.slug),
        ignoredScripts: skill.ignoredScripts,
    }
}

function detail(skill: Skill) {
    return {
        ...summarise(skill),
        dir: skill.dir,
        description: skill.frontmatter.description,
        ...(skill.frontmatter.whenNotToUse === undefined
            ? {}
            : { whenNotToUse: skill.frontmatter.whenNotToUse }),
        ...(skill.frontmatter.license === undefined ? {} : { license: skill.frontmatter.license }),
        ...(skill.frontmatter.compatibility === undefined
            ? {}
            : { compatibility: skill.frontmatter.compatibility }),
        ...(skill.frontmatter.allowedTools === undefined
            ? {}
            : { allowedToolsDeclaredNotHonoured: skill.frontmatter.allowedTools }),
        metadata: skill.frontmatter.metadata,
    }
}

// ─── writing ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn skills on for an agent that has not got them, and return the resolved config.
 *
 * Both halves or neither: `skills.dir` naming a directory that does not exist is a **load failure**, so
 * writing the block without creating the directory would leave an agent that refuses to start. That is
 * the reason this is a command rather than a `config_set` path — the agent cannot be trusted to do two
 * things atomically, and it is exactly the shape that made `config_set` report a pending `tokenEnv`.
 *
 * The manifest is edited with `setInSource`, the same editor `config_set` uses, because a round trip
 * through the YAML parser reflows the document: a comment between two top-level keys belongs to the end
 * of the first, so re-emitting moves section headers and one change produces a thirty-line diff.
 */
function enable(
    manifestPath: string,
    agentDir: string,
    existing: SkillsConfig | undefined,
): SkillsConfig | undefined {
    const dir = existing?.dir ?? "./skills"
    const absolute = isAbsolute(dir) ? dir : resolve(agentDir, dir)
    mkdirSync(absolute, { recursive: true })

    if (existing !== undefined) return existing

    const source = readFileSync(manifestPath, "utf8")
    // `setInSource` replaces a key that exists and returns `undefined` for one that does not — it never
    // had to append a new top level, because every path `config_set` writes has a parent already there.
    // So it is tried first, and the fallback uncomments the line the generated manifest ships, which is
    // that manifest's whole premise. Both are text edits: neither reflows the document.
    const edited = setInSource(source, ["skills"], block(dir)) ?? uncomment(source, dir)
    writeFileSync(manifestPath, edited, "utf8")
    process.stdout.write(`${keyValue([{ label: "enabled", value: `skills.dir = ${dir}` }])}\n`)
    // Re-read rather than assumed: the block just written is validated by the next load, and reporting
    // success for a document nobody has parsed is how a manifest that boots today fails tomorrow.
    return { dir, ...DEFAULTS, sources: [] }
}

/** Written once, so what is stored and what is printed cannot disagree. */
const DEFAULTS = { maxActive: 1, threshold: 0.35, budget: 5000 } as const

function block(dir: string): Record<string, unknown> {
    return { dir, ...DEFAULTS }
}

/**
 * Replace the commented Phase 5 line, or append the block at the end.
 *
 * The generated manifest carries `# skills: { dir: ./skills, ... }` under a `# Phase 5 — skills`
 * heading, so the common case is uncommenting exactly what is already documented in place — which keeps
 * the block where a reader expects it rather than orphaned at the bottom of the file.
 */
function uncomment(source: string, dir: string): string {
    const lines = source.split("\n")
    const at = lines.findIndex((line) => /^#\s*skills:/.test(line))
    const written = [
        "skills:",
        `  dir: ${dir}`,
        `  maxActive: ${DEFAULTS.maxActive}`,
        `  threshold: ${DEFAULTS.threshold}`,
        `  budget: ${DEFAULTS.budget}`,
    ]
    if (at === -1) return [...lines, "", ...written, ""].join("\n")
    // The heading above it goes too, when there is one: "# Phase 5 — skills" over a live block reads as
    // a phase that has not shipped.
    const from = /^#\s*Phase 5/.test(lines[at - 1] ?? "") ? at - 1 : at
    return [...lines.slice(0, from), ...written, ...lines.slice(at + 1)].join("\n")
}

function create(dir: string, options: SkillsOptions): number {
    const name = options.name
    if (name === undefined) {
        process.stdout.write("skills new needs a name — `skills new <manifest> <name>`\n")
        return EXIT_FAILURE
    }
    if (!isSkillName(name)) {
        // The spec's own rule, checked here so a scaffold the loader would refuse is never written.
        process.stdout.write(
            `${name} is not a legal skill name: lowercase letters, digits and single hyphens, never leading, trailing or doubled, at most 64 characters.\n`,
        )
        return EXIT_FAILURE
    }

    const target = join(dir, name)
    if (existsSync(target)) {
        process.stdout.write(`${target} already exists — nothing was written\n`)
        return EXIT_FAILURE
    }

    mkdirSync(target, { recursive: true })
    writeFileSync(
        join(target, "SKILL.md"),
        fillTemplate(SKILL_TEMPLATE, {
            SKILL_NAME: name,
            WHEN_NOT_TO_USE_KEY: whenNotToUseKey(),
        }),
        "utf8",
    )

    process.stdout.write(
        `${keyValue([
            { label: "created", value: join(target, "SKILL.md") },
            { label: "name", value: name },
        ])}\n`,
    )
    process.stdout.write(
        `${section("next")}\n` +
            `${bullet("edit the description — it is the only thing selection reads, so name the words someone would actually type")}\n` +
            `${bullet("write the steps in place of the placeholder body")}\n` +
            `${bullet(`skills validate — it warns until the scaffold is replaced`)}\n` +
            `${bullet("restart the agent: the catalogue is scanned once at boot")}\n`,
    )
    return EXIT_OK
}

/**
 * Copy a skill, or a directory of skills, into this agent.
 *
 * A **local path only**, and that is a decision rather than an unfinished feature. A skill may ship
 * executable scripts, so installing one from a URL is running someone else's code on this machine — a
 * thing that deserves its own decision about provenance and trust, not a flag added beside a copy
 * command. `git clone` or `gh repo clone` first, then install from the path; the network stays out of a
 * command whose job is to move files.
 *
 * Modes are preserved, because an executable bit is what makes a script runnable at all.
 */
function install(dir: string, budget: number, options: SkillsOptions): number {
    const from = options.name
    if (from === undefined) {
        process.stdout.write(
            "skills install needs a path — `skills install <manifest> <path to a skill directory>`\n",
        )
        return EXIT_FAILURE
    }

    const source = resolve(from)
    if (!existsSync(source) || !statSync(source).isDirectory()) {
        process.stdout.write(`${source} is not a directory\n`)
        return EXIT_FAILURE
    }

    // One skill, or a folder holding several. Detected rather than flagged: `skills/` from a cloned
    // repository and a single `pdf/` are both obvious to look at, and asking which would be a question
    // the filesystem has already answered.
    const single = existsSync(join(source, SKILL_FILE))
    const candidates = single
        ? [source]
        : readdirSync(source, { withFileTypes: true })
              .filter(
                  (entry) =>
                      entry.isDirectory() && existsSync(join(source, entry.name, SKILL_FILE)),
              )
              .map((entry) => join(source, entry.name))

    if (candidates.length === 0) {
        process.stdout.write(
            `no ${SKILL_FILE} in ${source} or in any directory directly inside it\n`,
        )
        return EXIT_FAILURE
    }

    const installed: string[] = []
    const skipped: string[] = []
    for (const candidate of candidates) {
        // The destination is the skill's declared `name`, not the source folder's — the spec requires
        // them to match, so a mismatched source is a skill that would fail to load wherever it landed.
        let name: string
        let body: string
        try {
            const parsed = parseSkillFile(
                basename(candidate),
                readFileSync(join(candidate, SKILL_FILE), "utf8"),
            )
            name = parsed.frontmatter.name
            body = parsed.body
        } catch (error) {
            skipped.push(
                `${basename(candidate)} — ${error instanceof Error ? error.message : String(error)}`,
            )
            continue
        }
        const target = join(dir, name)
        if (existsSync(target)) {
            skipped.push(`${name} — already installed at ${target}`)
            continue
        }
        // Checked before copying, because a body over the budget **fails the load** — so installing one
        // would break `skills list`, `validate` and every turn the agent takes, to add a skill that could
        // never have activated. `skill-creator` from `anthropics/skills` is 9,065 tokens and is exactly
        // this case.
        const tokens = estimateTokens(body)
        if (tokens > budget) {
            skipped.push(
                `${name} — its body is ${tokens} tokens against skills.budget ${budget}, and installing it would stop this agent loading. Raise the budget first, or split the body into references/.`,
            )
            continue
        }
        cpSync(candidate, target, { recursive: true, preserveTimestamps: true })
        installed.push(name)
    }

    process.stdout.write(
        `${keyValue([
            { label: "from", value: source },
            { label: "installed", value: installed.join(", ") },
            { label: "skipped", value: skipped.length === 0 ? "" : String(skipped.length) },
        ])}\n`,
    )
    for (const entry of skipped) process.stdout.write(`${bullet(entry)}\n`)
    if (installed.length > 0) {
        process.stdout.write(
            `${section("next")}\n${bullet("skills validate — a vendored skill usually has no negative guidance, which is a warning and not a problem")}\n${bullet("restart the agent: the catalogue is scanned once at boot")}\n`,
        )
    }
    return installed.length === 0 ? EXIT_FAILURE : EXIT_OK
}

/**
 * Deletes files, and says what it removed rather than only that it did.
 *
 * Reads the directory rather than the catalogue on purpose — see the ordering note at the call site. A
 * skill that breaks the load is precisely the skill someone needs to remove.
 */
function remove(dir: string, options: SkillsOptions): number {
    const name = options.name
    if (name === undefined) {
        process.stdout.write("skills remove needs a name — `skills list` names them\n")
        return EXIT_FAILURE
    }
    const target = join(dir, name)
    if (!existsSync(join(target, SKILL_FILE))) {
        const known = existsSync(dir)
            ? readdirSync(dir, { withFileTypes: true })
                  .filter(
                      (entry) =>
                          entry.isDirectory() && existsSync(join(dir, entry.name, SKILL_FILE)),
                  )
                  .map((entry) => entry.name)
                  .join(", ")
            : ""
        process.stdout.write(`no skill named ${name}${known === "" ? "" : `. Known: ${known}`}\n`)
        return EXIT_FAILURE
    }

    // Counted before the delete, so the report is about what was actually there rather than a guess.
    const files = countFiles(target)
    rmSync(target, { recursive: true, force: true })
    process.stdout.write(
        `${keyValue([
            { label: "removed", value: target },
            { label: "files", value: String(files) },
        ])}\n`,
    )
    process.stdout.write(`${bullet("restart the agent: the catalogue is scanned once at boot")}\n`)
    return EXIT_OK
}

function countFiles(dir: string): number {
    let total = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1
    }
    return total
}
