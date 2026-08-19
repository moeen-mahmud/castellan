/**
 * Events in, view state out. Pure, and the only place that decides what a turn looks like.
 *
 * The CLI has always been a `runtime.bus` subscriber; this makes it a *reducer* over that bus
 * instead of a set of callbacks writing to stdout. Three things follow from that:
 *
 * - "What does the reader see when a turn errors mid-stream?" is a unit test rather than something
 *   reproduced by hand against a live endpoint.
 * - Finished items are append-only and immutable, which is exactly the contract Ink's `<Static>`
 *   needs: a node written once and never re-rendered. The still-moving reply lives in `live`, so
 *   the dynamic region stays one item regardless of how long the conversation gets.
 * - Phase 4's SSE client and Phase 12's TUI client can consume the same reduction instead of
 *   re-deriving it.
 *
 * No clock and no randomness: ids come from a counter in the state, so the same events always
 * produce the same output and the tests need no fakes.
 */

import { ROLE_PREFIX } from "#lib/theme"
import type {
    TranscriptItem,
    TranscriptRole,
    TranscriptRow,
    TranscriptState,
    TurnStats,
} from "#lib/types"
import { wrapText } from "#lib/wrap"
import type { AnyEvent } from "@dispach/core"

/**
 * The transcript is driven by more than the bus — a typed line and a cancellation request are not
 * events — so the reducer takes an action union rather than an event directly.
 */
export type TranscriptAction =
    | { readonly kind: "user"; readonly text: string }
    | { readonly kind: "event"; readonly event: AnyEvent }
    | { readonly kind: "note"; readonly text: string }
    | { readonly kind: "cancelling" }
    /**
     * A model delta that has already been through the dialect's stream filter.
     *
     * Filtering cannot happen in here: a filter is stateful and this reducer is pure. So the caller
     * owns one per step and dispatches what is left. A caller that dispatches the raw `model.chunk`
     * event instead still works — it just shows the invocation blocks, which is right for a dialect
     * with no in-band protocol and wrong for NLT.
     */
    | { readonly kind: "delta"; readonly of: "text" | "reasoning"; readonly text: string }

export const EMPTY_TRANSCRIPT: TranscriptState = {
    items: [],
    live: undefined,
    status: "idle",
    nextId: 0,
}

function append(
    state: TranscriptState,
    role: TranscriptRole,
    text: string,
    stats?: TurnStats,
): TranscriptState {
    const item: TranscriptItem =
        stats === undefined
            ? { id: `t${state.nextId}`, role, text }
            : { id: `t${state.nextId}`, role, text, stats }
    return { ...state, items: [...state.items, item], nextId: state.nextId + 1 }
}

/** `data` is typed per event in core's map; narrowing by `type` first is what makes this safe. */
export function reduce(state: TranscriptState, action: TranscriptAction): TranscriptState {
    switch (action.kind) {
        case "user":
            return append(state, "user", action.text)

        case "note":
            return append(state, "note", action.text)

        case "cancelling":
            // A state, not an item. Cancellation that produced partial text still ends in a
            // `turn.end`, and that is what commits the text.
            return state.status === "idle" ? state : { ...state, status: "cancelling" }

        case "delta":
            return applyDelta(state, action.of, action.text)

        case "event":
            return reduceEvent(state, action.event)
    }
}

function applyDelta(
    state: TranscriptState,
    kind: "text" | "reasoning",
    delta: string,
): TranscriptState {
    if (delta === "") return state
    const live = state.live ?? { text: "", reasoning: "", last: undefined }
    return {
        ...state,
        live: {
            text: kind === "text" ? live.text + delta : live.text,
            reasoning: kind === "reasoning" ? live.reasoning + delta : live.reasoning,
            last: kind,
        },
        // A cancellation already asked for is not undone by another token arriving in flight; the
        // request stands until the turn actually ends.
        status: state.status === "cancelling" ? "cancelling" : "streaming",
    }
}

function reduceEvent(state: TranscriptState, event: AnyEvent): TranscriptState {
    switch (event.type) {
        case "turn.start":
            return {
                ...state,
                live: { text: "", reasoning: "", last: undefined },
                status: "thinking",
            }

        case "model.chunk":
            return applyDelta(state, event.data.kind, event.data.delta)

        case "tool.call":
            // Committed the moment the call starts, not when it returns: a tool that takes eight
            // seconds must not leave the screen looking like a stalled model. The row is completed by
            // `tool.result` appending its own line rather than by editing this one — `<Static>` has
            // already written it, and editing a written node silently does nothing.
            return {
                ...append(
                    state,
                    "tool",
                    `${event.data.slug}${event.data.mutating ? " (changes state)" : ""}`,
                ),
                status: state.status === "cancelling" ? "cancelling" : "working",
            }

        case "tool.result": {
            const { slug, ok, latencyMs, truncated } = event.data
            return append(
                state,
                ok ? "tool" : "error",
                `${slug} — ${ok ? "ok" : "failed"} · ${latencyMs} ms${truncated ? " · observation trimmed" : ""}`,
            )
        }

        case "tool.gated":
            // Deliberately visible. A blocked write is the one tool outcome a person must not have
            // to go looking for — and it is a `note` rather than an `error` because the wire spec is
            // explicit that this is not one: the turn continues and the model reports back.
            return append(state, "note", `${event.data.slug} — blocked: ${event.data.reason}`)

        case "tool.repair":
            // A silent repair is indistinguishable from a slow turn, and it costs a whole step.
            return append(
                state,
                "note",
                `${event.data.slugs.join(", ")} — could not be used, asking the model again`,
            )

        case "model.retry": {
            const { status, attempt, delayMs } = event.data
            return append(
                state,
                "note",
                `retrying after HTTP ${status} — attempt ${attempt}, waiting ${delayMs} ms`,
            )
        }

        case "turn.end": {
            const { reason, steps, tokens, durationMs } = event.data
            const live = state.live
            const stats: TurnStats = {
                promptTokens: tokens.prompt,
                outputTokens: tokens.output,
                durationMs,
                steps,
                reason,
            }

            // Reasoning is committed as its own item, ahead of the reply it produced. Whether it is
            // shown is the view's business; dropping it here would make --show-reasoning impossible
            // to honour after the fact.
            let next = state
            if (live !== undefined && live.reasoning !== "") {
                next = append(next, "reasoning", live.reasoning)
            }
            if (live !== undefined && live.text !== "") {
                next = append(next, "assistant", live.text, stats)
            } else if (reason === "final") {
                // A clean turn that produced nothing is not a normal outcome and must not look
                // like one.
                next = append(next, "note", "the model returned no text", stats)
            }
            return { ...next, live: undefined, status: "idle" }
        }

        case "agent.error":
        case "error": {
            const { code, message, hint } = event.data
            return append(state, "error", `${code}: ${message}\nhint: ${hint}`)
        }

        case "agent.warning": {
            const { code, message } = event.data
            return append(state, "note", `${code}: ${message}`)
        }

        case "context.pressure":
            // A gauge, so it replaces rather than accumulates. `source` is deliberately not shown: it
            // is diagnostic and the status line has no room for a word that changes nothing a person
            // would do — it is on the event for whoever is reading events.
            return { ...state, pressure: event.data.fraction }

        case "compaction.stage": {
            const { stage, changed, before, after } = event.data
            // Only the stages that destroy detail get a line. trim, snip and micro are recoverable —
            // the conversation is still in the store and a snipped observation keeps a pointer — while
            // collapse and reset replace a span of the conversation with a summary, and a person who
            // was not watching the gauge still needs to know that happened.
            if (!changed || (stage !== "collapse" && stage !== "reset")) return state
            const what =
                stage === "reset"
                    ? "the conversation so far was replaced by a summary"
                    : "earlier turns were replaced by a summary"
            return append(state, "note", `context: ${what} (${before} → ${after} tokens)`)
        }

        case "phase.changed": {
            const { to, tools } = event.data
            // A line *and* the gauge. The line because a phase change is the reason the agent's
            // abilities changed mid-conversation, and a person scrolling back needs it where it
            // happened; the gauge because "which phase am I in" is a current-state question.
            const next = append(
                state,
                "note",
                `phase: now in ${to} · ${tools} tool${tools === 1 ? "" : "s"} available`,
            )
            return { ...next, phase: to }
        }

        case "context.reset": {
            const { warning } = event.data
            // The count itself is not shown — the note above already said what happened. A *second*
            // reset is a configuration problem rather than a busy session, and that is worth a line.
            return warning === undefined ? state : append(state, "note", `context: ${warning}`)
        }

        default:
            // Boot and bookkeeping events — `runtime.ready`, `store.ready`, `model.call`,
            // `model.result`, `context.assembled`. They belong to the banner and the status bar,
            // not the transcript. Ignored explicitly so that a new event type added in a later
            // phase is inert here rather than a crash.
            return state
    }
}

/** What a renderer writes for a turn's cost. Kept here so the plain and rich paths agree. */
export function formatStats(stats: TurnStats): string {
    return `${stats.promptTokens} prompt · ${stats.outputTokens} output · ${stats.durationMs} ms`
}

/**
 * Opening banner — version, session, store, any turn a previous process left unfinished.
 *
 * One `banner` item rather than N notes, so the rich renderer can box it as a unit. The plain
 * path never calls this — it writes the lines directly — so plain output is unchanged by the
 * boxing.
 */
export function seed(notes: readonly string[]): TranscriptState {
    if (notes.length === 0) return EMPTY_TRANSCRIPT
    return append(EMPTY_TRANSCRIPT, "banner", notes.join("\n"))
}

/** The most recent completed turn's cost, for the status bar. */
export function lastStats(items: readonly TranscriptItem[]): TurnStats | undefined {
    for (let i = items.length - 1; i >= 0; i -= 1) {
        const stats = items[i]?.stats
        if (stats !== undefined) return stats
    }
    return undefined
}

// ─── the finished conversation, as rows ──────────────────────────────────────────────────

/**
 * Flatten items into the rows a windowed transcript scrolls through.
 *
 * ## Why rows rather than items
 *
 * Scrolling by item is the cheaper thing to build and the wrong unit. One assistant reply is a single
 * item and forty rows on screen, so an item-indexed window either shows the whole answer or none of it —
 * page-up from the bottom of a long reply would jump over the entire thing and land on the question
 * before it. Rows are what a reader moves through, so rows are what the offset counts.
 *
 * Wrapping happens here, not in Ink. A window has to know its content's height before it draws any of
 * it, and a count Ink might disagree with is a window off by however many lines wrapped — which shows up
 * as the last line of a reply hidden under the composer, intermittently, depending on the text.
 *
 * Pure, and one derivation for both halves of the frame: the component renders these rows and the layout
 * asks how many there are.
 */
export function transcriptRows(
    items: readonly TranscriptItem[],
    options: {
        readonly showReasoning: boolean
        readonly quiet: boolean
        readonly columns: number
    },
): readonly TranscriptRow[] {
    const rows: TranscriptRow[] = []
    const visible = items.filter((item) => item.role !== "reasoning" || options.showReasoning)

    for (const [at, item] of visible.entries()) {
        // A blank row between items, and never a trailing one. The rich transcript is read rather than
        // grepped, and two turns that touch each other read as one wall of text; a blank row at the end
        // would instead be a permanent gap above the composer.
        if (at > 0) rows.push({ key: `${item.id}:gap`, role: item.role, text: "" })

        if (item.role === "banner") {
            // The banner keeps its content and loses its border. A bordered box inside a windowed list
            // costs two rows this module cannot count — Ink measures the frame, not us — and the frame
            // was decoration on a surface that is now itself a frame.
            const [title = "", ...lines] = item.text.split("\n")
            rows.push({ key: `${item.id}:title`, role: "banner", text: title, bold: true })
            for (const [n, line] of lines.entries()) {
                for (const [w, wrapped] of wrapText(line, options.columns).entries()) {
                    rows.push({
                        key: `${item.id}:note-${n}-${w}`,
                        role: "banner",
                        text: wrapped,
                        dim: true,
                    })
                }
            }
            continue
        }

        const prefix = ROLE_PREFIX[item.role]
        const pad = " ".repeat([...prefix].length)
        // The prefix is part of the first row's width and an indent on every row after it, so a reply
        // that wraps stays in one column instead of reading as a second message.
        const body = wrapText(item.text, Math.max(1, options.columns - [...prefix].length))
        for (const [n, line] of body.entries()) {
            rows.push({
                key: `${item.id}:${n}`,
                role: item.role,
                text: `${n === 0 ? prefix : pad}${line}`,
            })
        }

        if (item.stats !== undefined && !options.quiet) {
            rows.push({
                key: `${item.id}:stats`,
                role: item.role,
                text: `  ${formatStats(item.stats)}`,
                dim: true,
            })
        }
    }

    return rows
}
