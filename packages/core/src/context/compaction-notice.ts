/**
 * The line that tells the model its context is managed for it.
 *
 * **Generated, never authored**, and that is the whole design. A person writing this into `AGENTS.md`
 * does not know the thresholds — they are manifest values with defaults, and they change without the
 * file changing — so an authored version is a sentence that goes stale silently and then teaches the
 * model something false about its own limits.
 *
 * The reason it exists at all is a behaviour, not a courtesy. A model that senses it is running out of
 * room *wraps up*: it shortens, it stops opening new threads of work, it starts summarising instead of
 * continuing, and it does so without saying why — which reads as a model that has lost interest in the
 * task rather than one budgeting. Telling it that older detail is removed automatically, that pinned
 * instructions are not, and that a pointer can be followed removes the reason to husband tokens.
 *
 * Three things it deliberately does not say. It gives **no numbers**: a threshold is a fraction of a
 * budget the model cannot see, and a figure it cannot act on is an invitation to arithmetic. It does
 * **not** ask the model to help — compaction is harness-driven (5.2) and a request to "keep things
 * short" is the wrapping-up behaviour this exists to remove. And it only mentions `artifact_read` when
 * that tool is actually in the catalogue, because naming a tool an agent does not have is how a model
 * comes to report that it tried something it never could.
 */

/** Present in the catalogue or not — the notice's one variable. */
export interface CompactionNoticeInput {
    readonly canReadArtifacts: boolean
}

export function renderCompactionNotice(input: CompactionNoticeInput): string {
    const lines = [
        "This conversation's context is managed for you. When it grows too long, older detail is",
        "removed automatically — oldest exchanges first, then large tool results, and in the last",
        "resort the earlier part of the conversation is replaced by a summary. Your standing",
        "instructions and this configuration are never removed.",
        "",
        "So do not shorten your work, wrap up early, or skip steps to save room. Write as much as the",
        "task needs.",
    ]
    if (input.canReadArtifacts) {
        lines.push(
            "",
            "A tool result that was removed leaves a marker naming an id. Pass that id to artifact_read",
            "to see the whole thing again.",
        )
    }
    return lines.join("\n")
}
