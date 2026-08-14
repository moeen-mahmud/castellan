/**
 * List-cursor state: an index and the moves that change it. Pure, like every reducer here.
 */

export interface SelectState {
    readonly index: number
    readonly count: number
}

export type SelectMove =
    | { readonly kind: "up" }
    | { readonly kind: "down" }
    | { readonly kind: "first" }
    | { readonly kind: "last" }
    /** 0-based. A digit key jumps the cursor — visibly and reversibly; it never chooses. */
    | { readonly kind: "jump"; readonly index: number }

export function moveSelect(state: SelectState, move: SelectMove): SelectState {
    if (state.count === 0) return state
    const last = state.count - 1
    switch (move.kind) {
        case "up":
            return { ...state, index: Math.max(0, state.index - 1) }
        case "down":
            return { ...state, index: Math.min(last, state.index + 1) }
        case "first":
            return { ...state, index: 0 }
        case "last":
            return { ...state, index: last }
        case "jump":
            return move.index < 0 || move.index > last ? state : { ...state, index: move.index }
    }
}
