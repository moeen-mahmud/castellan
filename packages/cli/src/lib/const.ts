/**
 * Every constant the CLI uses, in one place.
 *
 * The rule is the one termheat follows: no magic number inline. A width, a limit, or a control
 * sequence buried in a component is invisible to anyone tuning behaviour later, and two copies of
 * the same number drift.
 */

// ─── terminal ────────────────────────────────────────────────────────────────────────────

export const SHOW_CURSOR = "\u001B[?25h"
export const RESET_STYLE = "\u001B[0m"

/**
 * The alternate screen buffer — a second, empty screen the terminal swaps in, discards on the way
 * out, and never adds to the scrollback.
 *
 * `1049` rather than the older `47`: it saves the cursor position and clears the new buffer in one
 * sequence, which is what lands the shell prompt back where it was rather than wherever the app left
 * the cursor.
 *
 * The order on the way out is easy to get backwards. A style reset applies to whichever buffer is
 * *current*, so it has to be written before the swap away — reset afterwards and any colour the app
 * left on lands on the shell's screen instead of the one being discarded. `restoreTerminal` does them
 * in that order and says so there too.
 */
export const ENTER_ALT_SCREEN = "\u001B[?1049h"
export const LEAVE_ALT_SCREEN = "\u001B[?1049l"

/**
 * Fallback width. A pty can genuinely report `columns === 0` — measured, under `script -q`, which
 * is how this repo drives a real TTY in a test harness. Any layout maths that divides by the
 * terminal width has to survive that.
 */
export const FALLBACK_COLUMNS = 80
export const FALLBACK_ROWS = 24

/**
 * Rows the live pane may occupy before it starts showing only its tail.
 *
 * Ink erases and redraws its whole dynamic tree every frame, so an unbounded live region means
 * redrawing hundreds of lines per token. Finished messages move into `<Static>`, which is written
 * once and never touched again; this cap is what keeps the *unfinished* one cheap.
 */
export const LIVE_PANE_MAX_ROWS = 12

export const PROMPT = "› "

/**
 * The width a screen is laid out for, clamped at both ends.
 *
 * The floor is where the row layout drops its description column rather than wrapping — below it
 * nothing sensible is possible, and a wrapped row is what made the first skills list unreadable. The
 * ceiling stops a 300-column window putting a description a screen away from the name it belongs to.
 *
 * Here rather than in the one command that first needed them, because every screen now shares a frame
 * and two screens clamping differently is the drift `render.ts` was written to end.
 */
export const MIN_SCREEN_COLUMNS = 40
export const MAX_SCREEN_COLUMNS = 140

/** Rows a scrolling list may occupy, before and after the frame takes its share. */
export const MIN_SCREEN_ROWS = 8
export const MAX_SCREEN_ROWS = 40
/** Header, footer, margins and the counter — what the frame costs a list. */
export const SCREEN_CHROME_ROWS = 8

// ─── commands and input ──────────────────────────────────────────────────────────────────

// The command words themselves live in `session-commands.ts`, beside the summary that documents
// each one and the dispatch that honours it. Three bare string constants here is how the help text
// and the parser came to disagree in the first place.

/** Lines of input history kept for the up/down arrows. */
export const HISTORY_LIMIT = 200

/**
 * Undo points kept for the input buffer.
 *
 * Bounded because a snapshot holds a whole copy of the text, and a long composing session with a
 * pasted document in it would otherwise keep every intermediate version alive for the life of the
 * process. A run of typing is one point, not one per keystroke, so this is deeper than it looks.
 */
export const UNDO_LIMIT = 100

/**
 * Rows the input box may grow to before it scrolls internally.
 *
 * The same reasoning as `LIVE_PANE_MAX_ROWS`: the input is in Ink's dynamic region, which is erased and
 * redrawn every frame, so an unbounded box means redrawing a pasted document on every keystroke. It
 * also stops a long paste pushing the conversation off the screen.
 */
export const MAX_INPUT_ROWS = 10

/** Matches `^R` shows at once. Enough to recognise one, few enough to leave the prompt on screen. */
export const SEARCH_ROWS = 6

// ─── defaults ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ROW_LIMIT = 50
export const MIN_ROW_LIMIT = 1

// ─── exit codes ──────────────────────────────────────────────────────────────────────────

export const EXIT_OK = 0
export const EXIT_FAILURE = 1
/** 128 + SIGTERM, the shell convention. */
export const EXIT_SIGTERM = 143
