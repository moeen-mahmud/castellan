/**
 * How tall each piece of the chat frame is, so the conversation gets exactly the rows that are left.
 *
 * ## Why this has to be arithmetic and not flexbox
 *
 * On the alternate screen the layout has a hard ceiling: the terminal's height, with no scrollback to
 * absorb an overshoot. One row too many and Ink's own output scrolls the buffer, which leaves the status
 * line halfway up the display and the composer where the status line was — a corrupt frame rather than a
 * cramped one. Yoga will not save us here, because the thing that overflows is *our* choice of how many
 * transcript rows to hand it.
 *
 * So every piece of chrome reports its height, the sum is subtracted from the terminal, and the
 * conversation gets the remainder. `bodyRows` spends one further row as a margin, in the direction that
 * cannot be seen.
 *
 * ## The drift this invites, and how it is caught
 *
 * These functions restate each component's geometry, which means a component that grows a row without
 * changing its function here would make the frame one row too tall. That is a real hazard and it is
 * pinned by frame tests: each function is asserted against the line count of the actual render, so the
 * two cannot disagree for longer than one test run. Deriving the number *from* a render is not available
 * — the layout has to be decided before anything is drawn.
 *
 * Pure: editor state, palette matches and live text in, row counts out.
 */

import { lineInfo, searchMatches } from "#editor"
import { LIVE_PANE_MAX_ROWS, MAX_INPUT_ROWS } from "#lib/const"
import type { Palette } from "#lib/palette"
import { viewport } from "#lib/rows"
import { bodyRows } from "#lib/scroll"
import type { EditorState, LiveTurn } from "#lib/types"
import { livePane } from "#lib/wrap"

/** The header, the status line, and the row the transcript reserves for its scroll counter. */
const HEADER_ROWS = 1
const STATUS_ROWS = 1
const SCROLL_HINT_ROWS = 1
/** `Prompt` wraps `LineCursor` in a bordered box: one row of border above and one below. */
const PROMPT_BORDER_ROWS = 2
/** `\u00b7 reasoning \u00b7 ` — the prefix `Live` puts on its first row, which narrows the wrap. */
const LIVE_LABEL = 14

/** The composer, including its border and the newline hint it shows once a message has two lines. */
export function promptRows(editor: EditorState): number {
    const lines = editor.value.split("\n").length
    const { line } = lineInfo(editor)
    // Through `viewport`, the function `LineCursor` itself calls, rather than a second guess at where the
    // window lands. Each side of it spends a row on a "… n lines above/below" notice when it hides
    // something, so the count has to come from the same arithmetic that decides whether it does.
    const { from, to } = viewport(lines, line, Math.max(1, Math.min(lines, MAX_INPUT_ROWS)))
    return (
        PROMPT_BORDER_ROWS +
        (to - from) +
        (from > 0 ? 1 : 0) +
        (lines - to > 0 ? 1 : 0) +
        (lines > 1 ? 1 : 0)
    )
}

/** The slash-command list: its matches, its overflow notices, and the line naming its keys. */
export function paletteRows(palette: Palette | undefined, maxRows: number): number {
    if (palette === undefined) return 0
    // The empty case renders one line saying nothing matched, and no key hint — there is nothing to do.
    if (palette.matches.length === 0) return 1
    const shown = Math.min(palette.matches.length, maxRows)
    const overflow = palette.matches.length > shown ? 1 : 0
    return shown + overflow + 1
}

/** `^R`'s match list plus its query line. Zero when the search is closed. */
export function searchRows(editor: EditorState, maxRows: number): number {
    if (editor.search === undefined) return 0
    const matches = searchMatches(editor)
    return (matches.length === 0 ? 1 : Math.min(matches.length, maxRows)) + 1
}

export interface ChatFrame {
    /** Rows the conversation window may draw, its scroll counter already deducted. */
    readonly transcript: number
    /** Rows a pane over the conversation may draw. It replaces the transcript rather than sharing. */
    readonly pane: number
}

/**
 * The row budget for one frame.
 *
 * A pane and the transcript are alternatives, not neighbours. Rendered together the pane took a fixed
 * sixteen rows and pushed the conversation off the top of a full screen — and on a surface with no
 * scrollback, "off the top" means gone. Whichever is in front gets the body.
 */
export function chatFrame(inputs: {
    readonly rows: number
    readonly columns: number
    readonly editor: EditorState
    readonly live: LiveTurn | undefined
    readonly showReasoning: boolean
    readonly palette: Palette | undefined
    readonly searchMaxRows: number
    readonly paletteMaxRows: number
    /** A confirmation question, which is one line above the composer. */
    readonly confirming: boolean
}): ChatFrame {
    const live = inputs.live
    // The live pane shows reasoning only until the reply itself starts, which is the component's rule and
    // therefore has to be this one too.
    const liveText =
        live === undefined
            ? ""
            : inputs.showReasoning && live.reasoning !== "" && live.text === ""
              ? live.reasoning
              : live.text

    const chrome =
        HEADER_ROWS +
        STATUS_ROWS +
        livePane(liveText, inputs.columns - LIVE_LABEL, LIVE_PANE_MAX_ROWS).rows +
        paletteRows(inputs.palette, inputs.paletteMaxRows) +
        searchRows(inputs.editor, inputs.searchMaxRows) +
        promptRows(inputs.editor) +
        (inputs.confirming ? 1 : 0)

    const body = bodyRows(inputs.rows, chrome)
    // The pane draws its own two "… n lines above/below" notices and a key-hint line, which is why it
    // reports one row fewer than it is given rather than being handed the whole body.
    return { transcript: Math.max(1, body - SCROLL_HINT_ROWS), pane: Math.max(1, body - 3) }
}
