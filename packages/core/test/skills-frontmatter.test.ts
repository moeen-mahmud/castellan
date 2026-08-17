import { ConfigError } from "../src/errors.ts"
import { parseSkillFile, whenNotToUseKey } from "../src/skills/frontmatter.ts"
import { describe, expect, test } from "./_harness.ts"

function skill(frontmatter: string, body = "Do the thing."): string {
    return `---\n${frontmatter}\n---\n\n${body}\n`
}

function failure(dirName: string, raw: string): ConfigError {
    try {
        parseSkillFile(dirName, raw)
    } catch (error) {
        if (error instanceof ConfigError) return error
        throw error
    }
    throw new Error("expected parseSkillFile to throw")
}

describe("the two required fields", () => {
    test("a minimal spec-conformant skill parses", () => {
        const parsed = parseSkillFile(
            "pdf-processing",
            skill(
                "name: pdf-processing\ndescription: Extract text from PDFs. Use when handling PDFs.",
            ),
        )
        expect(parsed.frontmatter.name).toBe("pdf-processing")
        expect(parsed.frontmatter.description).toBe(
            "Extract text from PDFs. Use when handling PDFs.",
        )
        expect(parsed.frontmatter.whenNotToUse).toBeUndefined()
        expect(parsed.body).toBe("Do the thing.")
    })

    test("a missing description fails, and the message says why it matters", () => {
        const error = failure("charts", skill("name: charts"))
        expect(error.code).toBe("skill_file_invalid")
        expect(error.message).toContain("no description")
        expect(error.hint.length).toBeGreaterThan(0)
    })

    test("a whitespace-only description is a missing one", () => {
        expect(failure("charts", skill('name: charts\ndescription: "   "')).message).toContain(
            "no description",
        )
    })

    test("no frontmatter at all fails", () => {
        expect(failure("charts", "# Charts\n\nDo the thing.\n").message).toContain(
            "no leading --- frontmatter",
        )
    })

    test("frontmatter that is not a mapping fails", () => {
        expect(failure("charts", "---\n- one\n- two\n---\n\nbody\n").message).toContain(
            "did not parse to a mapping",
        )
    })
})

describe("the spec's name rules, as a table", () => {
    // Every row is a rule the published spec states. They are cheap to assert and the alternative is
    // discovering one of them from a skill that works here and nowhere else.
    const rejected: readonly { name: string; because: string }[] = [
        { name: "PDF-Processing", because: "uppercase" },
        { name: "-pdf", because: "leading hyphen" },
        { name: "pdf-", because: "trailing hyphen" },
        { name: "pdf--processing", because: "consecutive hyphens" },
        { name: "pdf processing", because: "a space" },
        { name: "pdf_processing", because: "an underscore" },
        { name: "pdf.processing", because: "a dot" },
    ]

    for (const { name, because } of rejected) {
        test(`${JSON.stringify(name)} is refused for ${because}`, () => {
            const error = failure(
                name,
                skill(`name: ${JSON.stringify(name)}\ndescription: A thing.`),
            )
            expect(error.message).toContain("not a legal skill name")
        })
    }

    test("digits and single hyphens are fine", () => {
        expect(
            parseSkillFile("pdf2-v3", skill("name: pdf2-v3\ndescription: A thing.")).frontmatter
                .name,
        ).toBe("pdf2-v3")
    })

    test("over 64 characters is refused, naming the length", () => {
        const long = "a".repeat(65)
        expect(failure(long, skill(`name: ${long}\ndescription: A thing.`)).message).toContain(
            "65 characters",
        )
    })

    test("a name that does not match its directory is refused, naming both", () => {
        const error = failure("charts", skill("name: chart-builder\ndescription: A thing."))
        expect(error.message).toContain('"chart-builder"')
        expect(error.message).toContain('"charts"')
    })
})

describe("negative guidance lives under metadata", () => {
    test("the key is derived from the brand, not written literally", () => {
        // If this ever hardcodes a product name it stops surviving `scripts/rename-brand.ts`, which is
        // the one thing hard rule 3 exists to protect.
        expect(whenNotToUseKey()).toMatch(/^[a-z0-9]+-when-not-to-use$/)
    })

    test("it is read from metadata into whenNotToUse", () => {
        const parsed = parseSkillFile(
            "pdf-processing",
            skill(
                `name: pdf-processing\ndescription: A thing.\nmetadata:\n  ${whenNotToUseKey()}: Not for scanned images.`,
            ),
        )
        expect(parsed.frontmatter.whenNotToUse).toBe("Not for scanned images.")
        // Still present in the raw map, so `skills show` can print every entry without special-casing.
        expect(parsed.frontmatter.metadata[whenNotToUseKey()]).toBe("Not for scanned images.")
    })

    test("its absence is not an error — that is decision 6.3's whole correction", () => {
        // Requiring it here would reject every skill from `anthropics/skills` and take 6.1's
        // compliance claim with it. `skills validate` warns instead.
        const parsed = parseSkillFile("charts", skill("name: charts\ndescription: A thing."))
        expect(parsed.frontmatter.whenNotToUse).toBeUndefined()
    })

    test("a non-string metadata value is coerced, not refused", () => {
        const parsed = parseSkillFile(
            "charts",
            skill("name: charts\ndescription: A thing.\nmetadata:\n  version: 1.0"),
        )
        expect(parsed.frontmatter.metadata.version).toBe("1")
    })

    test("metadata that is not a mapping fails", () => {
        expect(
            failure("charts", skill("name: charts\ndescription: A thing.\nmetadata: nope")).message,
        ).toContain("not a mapping")
    })
})

describe("third-party files load", () => {
    test("every optional spec field is read", () => {
        const parsed = parseSkillFile(
            "pdf-processing",
            skill(
                [
                    "name: pdf-processing",
                    "description: A thing.",
                    "license: Apache-2.0",
                    "compatibility: Requires Python 3.14+ and uv",
                    "allowed-tools: Bash(git:*) Read",
                ].join("\n"),
            ),
        )
        expect(parsed.frontmatter.license).toBe("Apache-2.0")
        expect(parsed.frontmatter.compatibility).toBe("Requires Python 3.14+ and uv")
        expect(parsed.frontmatter.allowedTools).toBe("Bash(git:*) Read")
    })

    test("an unknown top-level key is kept and ignored, where a workspace file would throw", () => {
        // The deliberate divergence from `parseWorkspaceFile`. A skill carrying a field the spec adds
        // next year must still load, because these files are not ours.
        const parsed = parseSkillFile(
            "charts",
            skill("name: charts\ndescription: A thing.\nsomething-new: value"),
        )
        expect(parsed.frontmatter.name).toBe("charts")
    })

    test("compatibility over 500 characters is refused", () => {
        const long = "x".repeat(501)
        expect(
            failure("charts", skill(`name: charts\ndescription: A thing.\ncompatibility: ${long}`))
                .message,
        ).toContain("501 characters")
    })

    test("description over 1024 characters is refused", () => {
        const long = "x".repeat(1025)
        expect(failure("charts", skill(`name: charts\ndescription: ${long}`)).message).toContain(
            "1025 characters",
        )
    })
})

describe("nothing meant for the loader or the author reaches the model", () => {
    test("HTML comments are stripped from the body", () => {
        const parsed = parseSkillFile(
            "charts",
            skill(
                "name: charts\ndescription: A thing.",
                "Step one.\n\n<!-- authoring note: keep this under 200 lines -->\n\nStep two.",
            ),
        )
        // Asserted on the whole body rather than with `not.toContain` — which the harness does not
        // carry — and it is the better assertion anyway: it pins the blank-line collapse too, so a
        // stripped comment cannot leave a crater where it was.
        expect(parsed.body).toBe("Step one.\n\nStep two.")
    })

    test("a --- later in the body stays a horizontal rule", () => {
        const parsed = parseSkillFile(
            "charts",
            skill("name: charts\ndescription: A thing.", "Before.\n\n---\n\nAfter."),
        )
        expect(parsed.body).toContain("---")
        expect(parsed.body).toContain("Before.")
    })
})
