/**
 * The skills catalogue: fetch, tick, pick an agent, install, and say what happened — in one mount.
 *
 * ## Why the whole lifecycle is in here
 *
 * The first version did only the ticking. The command fetched the catalogue *before* mounting and
 * printed the report *after* unmounting, so four of the five phases of the bare `skills` command were plain
 * `process.stdout.write`: a twenty-second clone with no spinner, then a picker, then a wall of text.
 * termheat's `App.tsx` is the shape this follows instead — mount, then load inside an effect, with the
 * wait rendered rather than printed.
 *
 * `load` and `install` arrive as async props, so the view reaches no filesystem and starts no process.
 * That is what keeps it renderable in a frame test; the host supplies both.
 *
 * ## The view contract
 *
 * It never mounts itself and never calls `useApp().exit()`. It reports through `onDone` and the host
 * decides what that means — unmount, for a command; close the pane, for the chat. `focused` gates the
 * one `useInput`, because Ink delivers input to *every* active hook, so a pane over a live prompt would
 * otherwise have both reading the same keystroke.
 */

import { Box, Text, useInput } from "ink"
import { useCallback, useEffect, useState } from "react"
import { CheckList } from "#components/CheckList"
import { Screen } from "#components/Screen"
import { SelectList } from "#components/SelectList"
import { Spinner } from "#components/Spinner"
import { useTerminalSize } from "#hooks/useTerminalSize"
import { keyToCheckIntent, keyToListIntent } from "#keymap"
import type { BrowseRow, InstallReport } from "#lib/browse"
import { chosenEntries, selectableOf } from "#lib/browse"
import { MAX_SCREEN_ROWS, MIN_SCREEN_ROWS, SCREEN_CHROME_ROWS } from "#lib/const"
import { firstSelectable, type MultiSelectState, reduceMultiSelect } from "#lib/multiselect"
import type { SandboxAgent } from "#lib/sandbox"
import { QUIT_HINT, type ScreenHeader } from "#lib/screen"
import { moveSelect, type SelectState } from "#lib/select"
import type { CatalogueEntry } from "#lib/source-cache"
import { GLYPH, THEME } from "#lib/theme"

export interface SkillBrowserProps {
    /** Fetch the catalogue, reporting progress. Called once, inside the mount. */
    readonly load: (onStatus: (line: string) => void) => Promise<readonly BrowseRow[]>
    readonly install: (
        skills: readonly CatalogueEntry[],
        manifestPath: string,
    ) => Promise<InstallReport>
    readonly agents: readonly SandboxAgent[]
    /** Install into this manifest and never ask which agent — for a host that already knows. */
    readonly target?: string
    /** Whether this surface has the keyboard. A pane over a live prompt must not share it. */
    readonly focused?: boolean
    /** Nothing left to do here. The host owns the exit. */
    readonly onDone: (report: InstallReport | undefined) => void
    readonly title: string
}

type Stage =
    | { readonly kind: "fetching"; readonly status: string }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "empty" }
    | { readonly kind: "picking" }
    | { readonly kind: "agent" }
    | { readonly kind: "installing"; readonly count: number }
    | { readonly kind: "done"; readonly report: InstallReport }

export function SkillBrowser({
    load,
    install,
    agents,
    target,
    focused = true,
    onDone,
    title,
}: SkillBrowserProps) {
    const size = useTerminalSize()
    const window = Math.max(
        MIN_SCREEN_ROWS,
        Math.min(MAX_SCREEN_ROWS, size.rows - SCREEN_CHROME_ROWS),
    )

    const [stage, setStage] = useState<Stage>({ kind: "fetching", status: "reading the catalogue" })
    const [rows, setRows] = useState<readonly BrowseRow[]>([])
    const [picked, setPicked] = useState<MultiSelectState>({
        cursor: { index: 0, count: 0 },
        chosen: [],
    })
    const [agent, setAgent] = useState<SelectState>({ index: 0, count: agents.length })

    // Inside the mount, so the wait is rendered rather than printed. Progress arrives through a
    // callback for the same reason: writing to stdout while Ink owns the frame paints over it.
    useEffect(() => {
        let live = true
        void load((status) => {
            if (live) {
                setStage((current) =>
                    current.kind === "fetching" ? { ...current, status } : current,
                )
            }
        })
            .then((fetched) => {
                if (!live) return
                setRows(fetched)
                const selectable = selectableOf(fetched)
                setPicked({
                    cursor: { index: firstSelectable(selectable), count: fetched.length },
                    chosen: [],
                })
                setStage(fetched.length === 0 ? { kind: "empty" } : { kind: "picking" })
            })
            .catch((error: unknown) => {
                if (!live) return
                setStage({
                    kind: "failed",
                    message: error instanceof Error ? error.message : String(error),
                })
            })
        return () => {
            live = false
        }
    }, [load])

    const selectable = selectableOf(rows)

    const begin = useCallback(
        (manifestPath: string) => {
            const skills = chosenEntries(rows, picked.chosen)
            setStage({ kind: "installing", count: skills.length })
            void install(skills, manifestPath)
                .then((report) => setStage({ kind: "done", report }))
                .catch((error: unknown) =>
                    setStage({
                        kind: "failed",
                        message: error instanceof Error ? error.message : String(error),
                    }),
                )
        },
        [rows, picked.chosen, install],
    )

    useInput(
        (input, key) => {
            if (stage.kind === "done") {
                onDone(stage.report)
                return
            }
            if (stage.kind === "failed" || stage.kind === "empty") {
                onDone(undefined)
                return
            }
            if (stage.kind === "fetching" || stage.kind === "installing") {
                // Only a way out. Anything else would queue a keystroke against a list that does not
                // exist yet, and a box ticking itself once the fetch lands is a surprise.
                if (keyToCheckIntent(input, key).kind === "cancel") onDone(undefined)
                return
            }

            if (stage.kind === "picking") {
                const intent = keyToCheckIntent(input, key)
                switch (intent.kind) {
                    case "move":
                    case "toggle":
                    case "all":
                        setPicked((current) =>
                            reduceMultiSelect(
                                current,
                                intent.kind === "move"
                                    ? { kind: "move", move: intent.move }
                                    : { kind: intent.kind },
                                selectable,
                            ),
                        )
                        return
                    case "none-selected":
                        setPicked((current) =>
                            reduceMultiSelect(current, { kind: "none" }, selectable),
                        )
                        return
                    case "confirm":
                        // Nothing ticked is not a reason to advance: enter with an empty set lands on an
                        // agent picker with nothing to install, one screen too late to notice.
                        if (picked.chosen.length === 0) return
                        if (target !== undefined) return begin(target)
                        if (agents.length === 1) return begin(agents[0]?.manifestPath ?? "")
                        setStage({ kind: "agent" })
                        return
                    case "cancel":
                        onDone(undefined)
                        return
                    case "none":
                        return
                }
            }

            const intent = keyToListIntent(input, key)
            switch (intent.kind) {
                case "move":
                    setAgent((current) => moveSelect(current, intent.move))
                    return
                case "choose": {
                    const chosen = agents[agent.index]
                    if (chosen !== undefined) begin(chosen.manifestPath)
                    return
                }
                case "back":
                    // Back to the skills, keeping what was ticked. The reason both steps are one view.
                    setStage({ kind: "picking" })
                    return
                case "exit":
                    onDone(undefined)
                    return
                case "none":
                    return
            }
        },
        { isActive: focused },
    )

    const count = picked.chosen.length
    const header: ScreenHeader = { title, summary: summaryFor(stage, rows.length, count) }

    if (stage.kind === "fetching") {
        return (
            <Screen header={header} footer={[{ key: "esc", does: "stop waiting" }]}>
                <Box marginLeft={2}>
                    <Spinner label={stage.status} />
                </Box>
                <Box marginLeft={2} marginTop={1}>
                    <Text dimColor>once per machine, shared by every agent on it</Text>
                </Box>
            </Screen>
        )
    }

    if (stage.kind === "failed") {
        return (
            <Screen header={header} footer={[{ key: "any key", does: "back" }]}>
                <Box marginLeft={2}>
                    <Text color={THEME.error}>
                        {GLYPH.error}
                        {stage.message}
                    </Text>
                </Box>
            </Screen>
        )
    }

    if (stage.kind === "empty") {
        return (
            <Screen header={header} footer={[{ key: "any key", does: "back" }]}>
                <Box marginLeft={2} flexDirection="column">
                    <Text color={THEME.muted}>no catalogue could be read</Text>
                    <Text dimColor>`sources update` reports why</Text>
                </Box>
            </Screen>
        )
    }

    if (stage.kind === "installing") {
        return (
            <Screen header={header}>
                <Box marginLeft={2}>
                    <Spinner
                        label={`installing ${stage.count} skill${stage.count === 1 ? "" : "s"}`}
                    />
                </Box>
            </Screen>
        )
    }

    if (stage.kind === "done") {
        return (
            <Screen header={header} footer={[{ key: "any key", does: "back" }]}>
                <ResultCard report={stage.report} />
            </Screen>
        )
    }

    if (stage.kind === "agent") {
        return (
            <Screen
                header={header}
                footer={[
                    { key: "↑↓", does: "move" },
                    { key: "enter", does: "install" },
                    { key: "esc", does: "back" },
                ]}
            >
                <SelectList
                    items={agents.map((entry) => ({
                        label: entry.name ?? entry.ref,
                        hint:
                            entry.problem === undefined
                                ? `${entry.modelId ?? "?"} ${GLYPH.bullet}${entry.ref}`
                                : `⚠ ${entry.problem}`,
                    }))}
                    index={agent.index}
                    numbered
                />
            </Screen>
        )
    }

    return (
        <Screen
            header={header}
            footer={[
                { key: "↑↓", does: "move" },
                { key: "space", does: "tick" },
                { key: "a/n", does: "all/none" },
                { key: "enter", does: target === undefined ? "continue" : "install" },
                QUIT_HINT,
            ]}
        >
            <CheckList
                rows={rows}
                index={picked.cursor.index}
                chosen={picked.chosen}
                window={window}
                width={size.columns}
            />
        </Screen>
    )
}

/** What the header says, per stage. Beside the stages, so a new one cannot be silently unlabelled. */
function summaryFor(stage: Stage, rows: number, ticked: number): string {
    switch (stage.kind) {
        case "fetching":
            return "fetching the catalogue"
        case "failed":
            return "could not be read"
        case "empty":
            return "nothing to show"
        case "installing":
            return "installing"
        case "done":
            return `installed ${stage.report.installed.length} of ${stage.report.total}`
        case "agent":
            return `${ticked} to install · pick an agent`
        case "picking":
            return ticked === 0
                ? `${rows} rows · nothing ticked yet`
                : `${ticked} ticked of ${rows} rows`
    }
}

/**
 * What happened, rendered from the same `InstallReport` the text path prints.
 *
 * Runnable files are counted rather than named: eleven skills brought 130 script paths, and a count
 * plus a pointer to `skills show` discloses more than 130 lines nobody reads.
 */
function ResultCard({ report }: { readonly report: InstallReport }) {
    return (
        <Box flexDirection="column" marginLeft={2}>
            <Text color={report.failed.length === 0 ? THEME.success : THEME.warning}>
                {GLYPH.check}
                {`installed ${report.installed.length} of ${report.total} skill${report.total === 1 ? "" : "s"}`}
            </Text>
            {report.installed.length > 0 ? (
                <Text dimColor wrap="truncate">
                    {report.installed.join(", ")}
                </Text>
            ) : null}
            {report.failed.map((failure) => (
                <Text key={failure.name} color={THEME.error} wrap="truncate">
                    {GLYPH.error}
                    {failure.name} — {failure.reason}
                </Text>
            ))}
            {report.runnable > 0 ? (
                <Box marginTop={1}>
                    <Text dimColor wrap="truncate">
                        {`${report.runnable} runnable file${report.runnable === 1 ? "" : "s"} across ${report.withCode} skill${report.withCode === 1 ? "" : "s"} — \`skills show <agent> <skill>\` names them`}
                    </Text>
                </Box>
            ) : null}
            <Box marginTop={1}>
                <Text dimColor>restart the agent: the catalogue is scanned once at boot</Text>
            </Box>
        </Box>
    )
}
