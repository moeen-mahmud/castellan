/**
 * `soul distill <file>` — scaffold a hand-edited compact identity from a long-form document.
 *
 * A scaffold, never a summary. The command copies the document's *structure* — its headings, and
 * its `<rules>` blocks verbatim, because rules are exactly what must survive distillation and
 * copying is not summarising — and leaves a placeholder under each heading for the author to fill.
 * Automatic summarisation of an identity document drops exactly the parts that produce voice,
 * which is why `onUnmet: distill` ships a committed file and not a runtime transformation.
 *
 * The placeholders are the `{{NAME}}` form the `workspace` command already warns about, on
 * purpose: an unedited scaffold keeps reporting itself until a person has written every section.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { HarnessError, parseWorkspaceFile } from "@dispach/core"
import { EXIT_OK } from "#lib/const"

export interface SoulOptions {
    readonly action: string
    readonly file: string
    readonly out?: string
}

const HEADING = /^(#{1,6})\s+(.*)$/
const RULES_OPEN = /^[ \t]*<rules(?:\s[^>]*)?>[ \t]*$/
const RULES_CLOSE = /^[ \t]*<\/rules>[ \t]*$/
const FENCE = /^\s*(?:```|~~~)/

export function soulCommand(options: SoulOptions): number {
    if (options.action !== "distill") {
        throw new HarnessError({
            code: "cli_soul_unknown_action",
            message: `soul takes the action "distill", not "${options.action}".`,
            hint: "Usage: soul distill <file> [--out <path>]. It scaffolds a compact identity file from a long-form document; the scaffold is edited by hand and named in context.soul.distilled.",
        })
    }

    let raw: string
    try {
        raw = readFileSync(options.file, "utf8")
    } catch {
        throw new HarnessError({
            code: "cli_soul_file_missing",
            message: `${options.file} is not readable.`,
            hint: "Point soul distill at the long-form identity document named by context.soul.file.",
        })
    }

    const source = basename(options.file)
    const out =
        options.out ?? join(dirname(options.file), `${source.replace(/\.md$/i, "")}.compact.md`)

    if (existsSync(out)) {
        throw new HarnessError({
            code: "cli_soul_out_exists",
            message: `${out} already exists, and a scaffold must not overwrite a file someone has edited.`,
            hint: "The compact file is the hand-edited artefact — regenerating it over someone's edits is exactly the loss automatic distillation would cause. Pass --out with a fresh path, or delete the file first if it really is disposable.",
        })
    }

    // The comments below are authoring guidance in the same sense as the workspace templates':
    // the loader strips them before injection, so they are free at runtime.
    const { body } = parseWorkspaceFile(source, raw)
    const scaffold = buildScaffold(source, body)

    writeFileSync(out, scaffold, "utf8")
    process.stdout.write(
        `wrote ${out}\n` +
            `\n` +
            `The scaffold copies ${source}'s headings and its <rules> blocks verbatim, and leaves a\n` +
            `{{PLACEHOLDER}} under each heading. Now:\n` +
            `  1. Fill every placeholder by hand — two or three sentences that must survive, in the\n` +
            `     document's own voice. The workspace command warns until none are left.\n` +
            `  2. Name the file in context.soul.distilled.\n`,
    )
    return EXIT_OK
}

/**
 * Structure over prose: headings and rules survive, everything else becomes a named placeholder.
 *
 * Deliberately line-oriented and fence-aware, like the renderer — a heading inside a fence is a
 * demonstration, not a section.
 */
function buildScaffold(source: string, body: string): string {
    const lines: string[] = [
        "---",
        "tier: static",
        "---",
        "",
        "<!--",
        `Compact identity scaffolded from ${source}. This file is the one small models actually`,
        `run on, so every sentence here is paid for on every turn — keep it to the few that`,
        `produce the voice. The long document stays the source of truth; edit it first, then`,
        `re-derive this by hand. These comments are stripped before injection and cost nothing.`,
        "-->",
        "",
    ]

    let inFence = false
    let inRules = false
    let sections = 0
    let sawHeading = false

    for (const line of body.split("\n")) {
        if (FENCE.test(line)) {
            inFence = !inFence
            if (inRules) lines.push(line)
            continue
        }
        if (inFence) {
            if (inRules) lines.push(line)
            continue
        }

        if (RULES_OPEN.test(line)) {
            inRules = true
            lines.push(line)
            continue
        }
        if (inRules) {
            lines.push(line)
            if (RULES_CLOSE.test(line)) {
                inRules = false
                lines.push("")
            }
            continue
        }

        const heading = HEADING.exec(line)
        if (heading !== null) {
            sawHeading = true
            sections += 1
            lines.push(line)
            lines.push("")
            lines.push(`{{SECTION_${sections}}}`)
            lines.push("")
        }
    }

    if (!sawHeading) {
        lines.push(`{{ESSENCE}}`)
        lines.push("")
    }

    return `${lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd()}\n`
}
