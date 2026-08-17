/**
 * The multi-select reducer: move a cursor, toggle rows, read back what was chosen.
 *
 * Pure, and PURE-listed for the same reason `select.ts` is — one `useInput` per screen root over a pure
 * keymap and a pure reducer, so the behaviour is unit-testable without mounting Ink and the component
 * cannot grow a second copy of the rules.
 *
 * `chosen` is a sorted index array rather than a `Set`, and that is deliberate: it makes the state
 * structurally comparable in a test (`toEqual`), keeps React's identity checks honest, and fixes the
 * install order to the order shown on screen — which is what somebody expects after ticking four boxes
 * top to bottom.
 *
 * Rows that are group headings are not selectable, so `count` alone is not enough: the reducer needs to
 * know which indices are real. `selectable` is passed in rather than derived, because the same reducer
 * serves a flat list (every row selectable) and a grouped one.
 */

import { moveSelect, type SelectMove, type SelectState } from "#lib/select"

export interface MultiSelectState {
    readonly cursor: SelectState
    /** Indices into the full row list, ascending. */
    readonly chosen: readonly number[]
}

export type MultiSelectAction =
    | { readonly kind: "move"; readonly move: SelectMove }
    | { readonly kind: "toggle" }
    | { readonly kind: "all" }
    | { readonly kind: "none" }

export function startMultiSelect(count: number): MultiSelectState {
    return { cursor: { index: 0, count }, chosen: [] }
}

/**
 * Advance the cursor past unselectable rows in the direction it was moving.
 *
 * Without this the cursor lands on a group heading and enter does nothing, which reads as a broken
 * keyboard. Group headings are the reason this exists, and the first row of a grouped list is always one.
 */
function skipUnselectable(
    state: SelectState,
    selectable: readonly boolean[],
    forward: boolean,
): SelectState {
    if (selectable.length === 0) return state
    let next = state
    // Bounded by the row count: a list with nothing selectable stops rather than looping forever.
    for (let step = 0; step < selectable.length; step += 1) {
        if (selectable[next.index] === true) return next
        next = moveSelect(next, { kind: forward ? "down" : "up" })
    }
    return state
}

export function reduceMultiSelect(
    state: MultiSelectState,
    action: MultiSelectAction,
    selectable: readonly boolean[],
): MultiSelectState {
    switch (action.kind) {
        case "move": {
            // With nothing selectable the cursor does not move at all, rather than moving onto a heading:
            // parking it on an unselectable row is the exact thing `skipUnselectable` exists to prevent, so
            // doing it as a fallback would be the bug wearing the fix's clothes.
            if (!selectable.includes(true)) return state
            const moved = moveSelect(state.cursor, action.move)
            const forward =
                action.move.kind === "down" ||
                action.move.kind === "last" ||
                (action.move.kind === "jump" && moved.index >= state.cursor.index)
            return { ...state, cursor: skipUnselectable(moved, selectable, forward) }
        }
        case "toggle": {
            const index = state.cursor.index
            if (selectable[index] !== true) return state
            const chosen = state.chosen.includes(index)
                ? state.chosen.filter((entry) => entry !== index)
                : [...state.chosen, index].sort((a, b) => a - b)
            return { ...state, chosen }
        }
        case "all": {
            const chosen = selectable.flatMap((ok, index) => (ok ? [index] : []))
            return { ...state, chosen }
        }
        case "none":
            return { ...state, chosen: [] }
    }
}

/** Where the cursor should start: the first selectable row, never a heading. */
export function firstSelectable(selectable: readonly boolean[]): number {
    const index = selectable.indexOf(true)
    return index === -1 ? 0 : index
}
