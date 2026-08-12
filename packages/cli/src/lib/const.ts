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

// ─── commands and input ──────────────────────────────────────────────────────────────────

export const EXIT_WORDS: readonly string[] = ["/exit", "/quit", ":q"]
export const RESET_WORD = "/reset"
export const HELP_WORD = "/help"

/** Lines of input history kept for the up/down arrows. */
export const HISTORY_LIMIT = 200

// ─── defaults ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ROW_LIMIT = 50
export const MIN_ROW_LIMIT = 1

// ─── exit codes ──────────────────────────────────────────────────────────────────────────

export const EXIT_OK = 0
export const EXIT_FAILURE = 1
/** 128 + SIGTERM, the shell convention. */
export const EXIT_SIGTERM = 143
