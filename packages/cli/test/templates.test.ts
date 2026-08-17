/**
 * The embedded templates and `examples/workspace-template/` must be the same bytes.
 *
 * The examples directory is the human-edited source of truth — it is what the docs point at and
 * what a person reads to learn the authored form. The constants in `lib/templates.ts` are what
 * the installed binary actually ships, because `dist/` has no `examples/` beside it. Two copies
 * of anything drift; this test is what turns that drift from a silent scaffold divergence into a
 * red CI run naming the file.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
    fillTemplate,
    SKILL_TEMPLATE,
    WORKSPACE_TEMPLATE_FILES,
    WORKSPACE_TEMPLATES,
} from "#lib/templates"

const TEMPLATE_DIR = resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "examples",
    "workspace-template",
)

describe("template embedding", () => {
    test("the starter skill matches examples/workspace-template byte for byte", () => {
        const source = readFileSync(join(TEMPLATE_DIR, "skills", "starter", "SKILL.md"), "utf8")
        expect(SKILL_TEMPLATE).toBe(source)
    })

    for (const name of WORKSPACE_TEMPLATE_FILES) {
        test(`${name} matches examples/workspace-template byte for byte`, () => {
            const source = readFileSync(join(TEMPLATE_DIR, name), "utf8")
            expect(WORKSPACE_TEMPLATES[name]).toBe(source)
        })
    }

    test("every template declares its tier in frontmatter", () => {
        for (const name of WORKSPACE_TEMPLATE_FILES) {
            expect(WORKSPACE_TEMPLATES[name].startsWith("---\ntier: ")).toBe(true)
        }
    })
})

describe("fillTemplate", () => {
    test("fills known tokens and leaves unknown ones for the nag", () => {
        const out = fillTemplate("# {{AGENT_NAME}}\n{{USER}}: {{INPUT_1}}", {
            AGENT_NAME: "Milo",
            USER: "Moeen",
        })
        expect(out).toBe("# Milo\nMoeen: {{INPUT_1}}")
    })

    test("tolerates whitespace inside the braces, like the authoring check does", () => {
        expect(fillTemplate("{{ AGENT_NAME }}", { AGENT_NAME: "Milo" })).toBe("Milo")
    })
})
