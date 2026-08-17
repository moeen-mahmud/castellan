/**
 * Bare `skills`, with no arguments: the catalogue, ticked, installed into an agent you pick.
 *
 * This is the entry point the owner asked for and the one the surface was missing. Everything else
 * required knowing something first — `skills list <agent>` needs an agent, `sources search <words>` needs
 * words, and `skills install <agent> <source>/<skill>` needs the name of a skill you have not seen yet.
 * A person who wants skills has none of those, so the command that takes no arguments has to be the one
 * that shows what exists.
 *
 * ## What it does not do
 *
 * It does not fetch on a pipe. `--plain`, a redirect, or CI gets the same list as text, from the same
 * `browseRows`, with the two commands that install a skill non-interactively printed underneath — because
 * a picker is not scriptable and pretending otherwise means somebody's CI job hangs on a keypress.
 *
 * It also does not resolve an agent for you when there are several. Installing somebody else's executable
 * code into whichever agent happened to sort first is not a default worth having, so the second screen
 * asks — and with exactly one agent it does not, because there is nothing to ask.
 */

import { BRAND, HarnessError, VERSION } from "@castellan/core"
import { type BrowseInput, type BrowseRow, browseRows } from "#lib/browse"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { flushOutput, markTerminalDirty, onExit } from "#lib/exit"
import { resolveModeFromProcess } from "#lib/output"
import { bullet, indent, section } from "#lib/render"
import { columnsFor, layoutRow } from "#lib/rows"
import { listAgents, type SandboxAgent } from "#lib/sandbox"
import {
    type CatalogueEntry,
    fetchSource,
    type Git,
    isCached,
    readCatalogue,
} from "#lib/source-cache"
import { loadSources } from "#lib/sources"
import { type InstallOutcome, skillsCommand } from "#skills"

export interface BrowseOptions {
    readonly plain?: boolean
    readonly json?: boolean
    /** Injected by the tests, which never reach a network. */
    readonly git?: Git
    readonly env?: Readonly<Record<string, string | undefined>>
    /** Both overridden in tests; at a terminal they are measured from the stream. */
    readonly rows?: number
    readonly width?: number
}

/** Rows left for the list after the banner, the hint line and the counter. */
const CHROME_ROWS = 8
const MIN_WINDOW = 8
const MAX_WINDOW = 40

/**
 * Fetch what is not cached, then build the rows. Shared by the command and by `init`.
 *
 * Announced before the work: the first run pays ~40 MB once per machine and every agent on it shares the
 * result, and a command that pauses for twenty seconds with no output is indistinguishable from one that
 * has hung — the failure this whole area's git wrapper exists to prevent.
 */
/**
 * Fetch what is not cached, then build the rows — reporting progress through a callback.
 *
 * A callback rather than `process.stdout` because one caller is *inside* a rendered screen, where writing
 * to stdout paints over the frame Ink is managing. The other caller passes a writer and gets the same lines
 * on a pipe. This is the seam that lets the init wizard show a spinner instead of a printed line.
 */
export async function fetchCatalogue(
    options: BrowseOptions & { readonly onStatus?: (line: string) => void },
): Promise<readonly BrowseRow[]> {
    const say = options.onStatus ?? (() => {})
    const sources = loadSources(options.env)
    const cold = sources.filter((spec) => !isCached(spec.name, options.env))
    for (const [at, spec] of cold.entries()) {
        say(
            `fetching ${spec.name} (${at + 1} of ${cold.length}) — once per machine, shared by every agent`,
        )
        try {
            const result = await fetchSource(spec, {
                ...(options.env === undefined ? {} : { env: options.env }),
                ...(options.git === undefined ? {} : { git: options.git }),
            })
            say(`${spec.name}: ${result.skills} skills`)
        } catch (error) {
            say(
                `${spec.name} could not be fetched: ${error instanceof HarnessError ? error.message : String(error)}`,
            )
        }
    }
    const inputs: BrowseInput[] = sources
        .filter((spec) => isCached(spec.name, options.env))
        .map((spec) => ({ spec, entries: readCatalogue(spec, options.env) }))
    return browseRows(inputs)
}

/** The same thing for the paths that own the terminal, printing each line as it happens. */
export async function catalogueRows(options: BrowseOptions): Promise<readonly BrowseRow[]> {
    return await fetchCatalogue({
        ...options,
        onStatus: (line) => process.stdout.write(`${line}\n`),
    })
}

/**
 * Install a list of `<source>/<skill>` refs, reporting once.
 *
 * Exported for `init`, whose wizard already collected the refs on its own screen — so it needs the install
 * without the picker.
 */
export function installRefs(
    refs: readonly string[],
    manifestPath: string,
    options: BrowseOptions & { readonly envOverlay?: Readonly<Record<string, string | undefined>> },
): number {
    const outcomes: InstallOutcome[] = []
    for (const ref of refs) {
        skillsCommand({
            action: "install",
            manifestPath,
            name: ref,
            quiet: true,
            collect: outcomes,
            ...(options.env === undefined ? {} : { sandboxEnv: options.env }),
            ...(options.envOverlay === undefined ? {} : { envOverlay: options.envOverlay }),
        })
    }
    return report(outcomes)
}

/**
 * One `skills install` per skill rather than one call with a list.
 *
 * The command's contract is one ref, it reports per skill, and a partial failure leaves the successful
 * ones installed with a named reason for the rest — batching would have to reimplement all of that.
 */
function installEach(
    skills: readonly CatalogueEntry[],
    manifestPath: string,
    options: BrowseOptions & { readonly envOverlay?: Readonly<Record<string, string | undefined>> },
): number {
    return installRefs(
        skills.map((entry) => `${entry.source}/${entry.skill}`),
        manifestPath,
        options,
    )
}

/** The one report for a batch, whatever produced it. */
function report(outcomes: readonly InstallOutcome[]): number {
    const ok = outcomes.filter((outcome) => outcome.ok)
    const failed = outcomes.filter((outcome) => !outcome.ok)
    const runnable = ok.flatMap((outcome) => outcome.runnable)

    // One report for the whole batch. Eleven ticked skills used to produce eleven of these.
    process.stdout.write(
        `${section(`installed ${ok.length} of ${outcomes.length} skill${outcomes.length === 1 ? "" : "s"}`, true)}\n`,
    )
    if (ok.length > 0) {
        process.stdout.write(`${indent(ok.map((outcome) => outcome.name).join(", "))}\n`)
    }
    for (const outcome of failed) {
        process.stdout.write(
            `${bullet(`${outcome.name} — ${outcome.reason ?? "not installed"}`)}\n`,
        )
    }
    if (runnable.length > 0) {
        // Counted here and named per skill by `skills show`. Twelve file paths per skill across eleven
        // skills is 130 lines of disclosure nobody reads, which discloses less than one honest sentence.
        process.stdout.write(
            `${section("code that came with them")}\n${indent(
                `${runnable.length} runnable file${runnable.length === 1 ? "" : "s"} across ${
                    ok.filter((outcome) => outcome.runnable.length > 0).length
                } skill${ok.filter((outcome) => outcome.runnable.length > 0).length === 1 ? "" : "s"} — \`skills show <agent> <skill>\` names them`,
            )}\n`,
        )
    }
    return failed.length
}

export async function browseCommand(options: BrowseOptions): Promise<number> {
    const sources = loadSources(options.env)
    if (sources.length === 0) {
        process.stdout.write(
            `no skill sources are configured\n\n  \`${BRAND.slug} sources add <url>\` adds one — a repository holding a skills/ directory.\n`,
        )
        return EXIT_FAILURE
    }

    const decision = resolveModeFromProcess({
        plain: options.plain === true,
        json: options.json === true,
        oneShot: false,
    })
    const interactive = decision.mode === "rich"

    const rows = await catalogueRows(options)
    if (rows.length === 0) {
        process.stdout.write(
            `nothing to show — no catalogue could be read\n\n  \`${BRAND.slug} sources update\` reports why.\n`,
        )
        return EXIT_FAILURE
    }

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    skills: rows
                        .filter((row) => row.entry !== undefined)
                        .map((row) => ({
                            ref: `${row.entry?.source}/${row.entry?.skill}`,
                            source: row.entry?.source,
                            skill: row.entry?.skill,
                            tokens: row.entry?.tokens,
                            scripts: row.entry?.scripts.length ?? 0,
                            description: row.entry?.description,
                        })),
                },
                null,
                2,
            )}\n`,
        )
        return EXIT_OK
    }

    const agents = listAgents(options.env)
    if (!interactive) return plainList(rows, agents)

    if (agents.length === 0) {
        process.stdout.write(
            `${plainListText(rows)}\n${section("no agent to install into")}\n${indent(`\`${BRAND.slug} init\` creates one, then this command installs into it.`)}\n`,
        )
        return EXIT_FAILURE
    }

    const [{ render }, { createElement }, { SkillBrowser }] = await Promise.all([
        import("ink"),
        import("react"),
        import("#components/SkillBrowser"),
    ])

    let result:
        | { kind: "install"; skills: readonly CatalogueEntry[]; manifestPath: string }
        | { kind: "quit" } = {
        kind: "quit",
    }
    markTerminalDirty()
    const instance = render(
        createElement(SkillBrowser, {
            rows,
            agents,
            window: windowFor(options.rows),
            width: widthFor(options.width),
            onDone: (picked) => {
                result = picked
            },
        }),
        { exitOnCtrlC: false },
    )
    onExit(() => instance.unmount())
    await instance.waitUntilExit()
    instance.unmount()
    flushOutput()

    const picked = result as
        | { kind: "install"; skills: readonly CatalogueEntry[]; manifestPath: string }
        | { kind: "quit" }
    if (picked.kind === "quit" || picked.skills.length === 0) {
        process.stdout.write("nothing installed\n")
        return EXIT_OK
    }

    const failures = installEach(picked.skills, picked.manifestPath, options)
    process.stdout.write(`${bullet("restart the agent: the catalogue is scanned once at boot")}\n`)
    return failures === picked.skills.length ? EXIT_FAILURE : EXIT_OK
}

/**
 * Terminal columns, clamped.
 *
 * The floor matters: at 40 columns the layout drops the description rather than wrapping, and below that
 * nothing sensible is possible — a wrapped row is what made the first version unreadable. The ceiling keeps
 * a 300-column window from putting the description a screen away from the name it belongs to.
 */
export function widthFor(columns: number | undefined): number {
    const width = columns ?? process.stdout.columns ?? 80
    return Math.max(40, Math.min(140, width))
}

/** How many rows the list gets. Measured from the terminal, clamped so it is neither cramped nor endless. */
export function windowFor(rows: number | undefined): number {
    const height = rows ?? process.stdout.rows ?? 24
    return Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, height - CHROME_ROWS))
}

/**
 * The pipe's rendering: the same rows, laid out in the same columns, at a fixed 100.
 *
 * Fixed rather than measured, because a redirected stream has no width and output that changed shape
 * depending on the terminal it was *not* written to is output no test can pin.
 */
function plainListText(rows: readonly BrowseRow[]): string {
    const width = 100
    const longest = rows.reduce(
        (max, row) => (row.kind === "item" ? Math.max(max, row.label.length) : max),
        0,
    )
    // `longest + 12` and a matching ceiling, because each name is printed as `<source>/<skill>` here.
    const columns = columnsFor(width, longest + 12, { nameMax: 46 })
    const lines: string[] = []
    for (const row of rows) {
        if (row.kind === "source") {
            lines.push(`\n${row.label}`)
            continue
        }
        if (row.kind === "group") {
            lines.push(`  ${row.label}`)
            continue
        }
        const cells = layoutRow(
            {
                name: `${row.entry?.source}/${row.label}`,
                meta: row.meta ?? "",
                description: row.description ?? "",
            },
            columns,
        )
        lines.push(`    ${cells.name}  ${cells.meta}  ${cells.description}`.trimEnd())
    }
    return lines.join("\n")
}

/**
 * The pipe's answer: the same rows, plus the two commands that install one without a keypress.
 *
 * Exits 0. Asking what exists is a legitimate question and it was answered — unlike bare `run`, which
 * exits non-zero on a pipe because nothing ran and something was supposed to.
 */
function plainList(rows: readonly BrowseRow[], agents: readonly SandboxAgent[]): number {
    process.stdout.write(`${plainListText(rows)}\n`)
    const example = rows.find((row) => row.entry !== undefined)?.entry
    const agent = agents[0]?.ref ?? "<agent>"
    process.stdout.write(
        `${section("install")}\n${indent(`${BRAND.slug} skills install ${agent} ${example?.source ?? "anthropic"}/${example?.skill ?? "pdf"}`)}\n${indent(`${BRAND.slug} skills — at a terminal, ticks several at once`, 2)}\n`,
    )
    return EXIT_OK
}

/** Kept beside the command so the banner and the picker cannot disagree about the version. */
export const BROWSE_TITLE = `${BRAND.name} ${VERSION}`
