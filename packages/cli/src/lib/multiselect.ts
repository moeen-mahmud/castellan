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
 * Walk from a landing point until a selectable row is found, in one direction.
 *
 * `undefined` when the walk reaches the end of the list without finding one. Detected by the index
 * stopping rather than by counting: `moveSelect` clamps at both ends, so a walk that has run out of
 * list returns the same index forever, and *that* is the honest end condition.
 */
function walk(
    from: SelectState,
    selectable: readonly boolean[],
    forward: boolean,
): SelectState | undefined {
    let next = from
    for (let step = 0; step <= selectable.length; step += 1) {
        if (selectable[next.index] === true) return next
        const after = moveSelect(next, { kind: forward ? "down" : "up" })
        if (after.index === next.index) return undefined
        next = after
    }
    return undefined
}

/**
 * Put the cursor on a selectable row, given where it was and where the move would have put it.
 *
 * Without this the cursor lands on a group heading and enter does nothing, which reads as a broken
 * keyboard. Group headings are the reason it exists, and the first row of a grouped list is always one.
 *
 * Three passes, in order, and the order is the whole correctness argument:
 *
 * 1. **Continue the way it was going.** Down past a heading keeps going down.
 * 2. **Reverse.** The walk ran out of list — pressing up on the first skill of a grouped catalogue lands
 *    on the source heading with nothing selectable above it, so the answer is the row below, which is
 *    where the cursor already was. This pass is also what makes `g` (first) and `G` (last) work: `g`
 *    lands on row 0, which in a grouped list is always a heading, and only a downward search finds
 *    anything.
 * 3. **Stay put.** Nothing anywhere is selectable.
 *
 * Returning `moved` on exhaustion — which is what the first version did, by falling through to its own
 * parameter — put the cursor on the heading. That is the bug this function exists to prevent, wearing
 * the fix's clothes, and a frame test caught it by noticing the pointer had vanished from the list
 * entirely: a heading row draws no cursor, so parking there makes the cursor *invisible* as well as
 * inert.
 */
function selectableCursor(
    from: SelectState,
    moved: SelectState,
    selectable: readonly boolean[],
    forward: boolean,
): SelectState {
    if (selectable.length === 0) return from
    return walk(moved, selectable, forward) ?? walk(moved, selectable, !forward) ?? from
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
            // Derived from where the cursor actually went rather than from the kind of move, because
            // the two disagree for `first` and `last`: `g` travels *backwards* to row 0 and then has to
            // search *forwards* to find anything selectable. Reading it off the indices makes every
            // move kind — including a digit jump — fall out of one rule.
            const forward = moved.index >= state.cursor.index
            return { ...state, cursor: selectableCursor(state.cursor, moved, selectable, forward) }
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
