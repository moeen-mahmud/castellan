import { activate } from "../src/context/activate.ts"
import type { Skill } from "../src/skills/index.ts"
import { bm25Selector } from "../src/skills/select.ts"
import { describe, expect, test } from "./_harness.ts"

/**
 * The catalogue the fixtures below are scored against.
 *
 * Eight plausible skills rather than three, because the scorer's behaviour depends on corpus statistics:
 * `discriminating()` excludes a term appearing in more than half the corpus, and with three skills that
 * threshold is meaningless. Descriptions are written the way the spec advises — what it does *and* when
 * to use it — so the fixtures measure the scorer rather than measuring bad authoring.
 */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
    "pdf-processing":
        "Extract text and tables from PDF files, fill PDF forms, and merge multiple PDFs. Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction.",
    "chart-builder":
        "Create bar, line and pie charts from tabular data and export them as PNG or SVG images. Use when the user asks for a graph, plot, chart or visualisation of numbers.",
    "git-release":
        "Cut a tagged release: bump the version, update the changelog, tag the commit and push. Use when the user asks to release, ship a version, or publish a new tag.",
    "sql-explain":
        "Analyse a slow SQL query, read its execution plan and suggest indexes. Use when a database query is slow or the user mentions EXPLAIN, query plans or missing indexes.",
    "csv-clean":
        "Normalise a messy CSV: fix encodings, trim whitespace, deduplicate rows and coerce column types. Use when the user has a CSV or a spreadsheet export that needs cleaning.",
    "email-triage":
        "Sort an inbox into action, waiting and archive, and draft short replies. Use when the user asks to go through email, triage an inbox, or clear a backlog of messages.",
    "docker-build":
        "Write and debug a Dockerfile, shrink image size with multi-stage builds and diagnose build cache misses. Use when the user is containerising an app or a docker build fails.",
    "meeting-notes":
        "Turn a raw transcript into structured notes with decisions, owners and action items. Use when the user pastes a transcript or asks for meeting minutes.",
}

const CATALOGUE: readonly Skill[] = Object.entries(DESCRIPTIONS).map(([name, description]) => ({
    name,
    dir: `/skills/${name}`,
    tokens: 100,
    scripts: [],
    ignoredScripts: [],
    frontmatter: { name, description, metadata: {} },
}))

/** The shipped default. Asserted against, so a change to it has to face these numbers. */
const THRESHOLD = 0.35

const FIXTURES: readonly { readonly query: string; readonly want: string }[] = [
    { query: "can you pull the tables out of this invoice pdf", want: "pdf-processing" },
    { query: "I need a bar chart of last quarter's revenue", want: "chart-builder" },
    { query: "let's ship version 2.1", want: "git-release" },
    { query: "this query takes 40 seconds, what indexes am I missing", want: "sql-explain" },
    {
        query: "the csv export from salesforce is a mess, duplicate rows everywhere",
        want: "csv-clean",
    },
    { query: "help me get through my inbox", want: "email-triage" },
    { query: "my docker build keeps missing the cache", want: "docker-build" },
    { query: "here's the transcript from standup, give me action items", want: "meeting-notes" },
    { query: "merge these three pdfs into one", want: "pdf-processing" },
    { query: "plot this as a line graph", want: "chart-builder" },
    { query: "tag the commit and push a release", want: "git-release" },
    { query: "read the execution plan for me", want: "sql-explain" },
    { query: "fix the encodings in this spreadsheet export", want: "csv-clean" },
    { query: "draft short replies to these messages", want: "email-triage" },
    { query: "shrink this image with a multi-stage build", want: "docker-build" },
    { query: "turn these meeting minutes into decisions and owners", want: "meeting-notes" },
    { query: "fill in this pdf form for me", want: "pdf-processing" },
]

function top(query: string): { name: string; score: number } | undefined {
    const first = bm25Selector(query, CATALOGUE)[0]
    if (first === undefined || first.score === 0) return undefined
    return { name: first.skill.name, score: first.score }
}

describe("selection over 17 positive fixtures", () => {
    for (const { query, want } of FIXTURES) {
        test(`${JSON.stringify(query)} → ${want}`, () => {
            const best = top(query)
            expect(best?.name).toBe(want)
            expect(best?.score ?? 0).toBeGreaterThanOrEqual(THRESHOLD)
        })
    }

    test("the default threshold sits below every positive, and the margin is thin", () => {
        // Measured: the positives span 0.390 to 0.633, so 0.35 clears the lowest by about 11%. Asserted
        // rather than described, because a change to the scoring formula that quietly pushes the floor
        // under the default would otherwise show up as one fixture failing for no obvious reason.
        const scores = FIXTURES.map(({ query }) => top(query)?.score ?? 0)
        expect(Math.min(...scores)).toBeGreaterThan(THRESHOLD)
        expect(Math.min(...scores)).toBeLessThan(0.4)
        expect(Math.max(...scores)).toBeLessThan(1)
    })
})

describe("a query about nothing in the catalogue selects nothing", () => {
    for (const query of ["what's the weather in dhaka tomorrow", "who won the 1998 world cup"]) {
        test(JSON.stringify(query), () => {
            expect(top(query)).toBeUndefined()
        })
    }

    test("an ultra-common term cannot carry a score on its own", () => {
        // The regression test for the defect that measurement found. Before `discriminating()`, "what's
        // the weather in dhaka tomorrow" reduced to the single corpus term `the` and scored **0.771**
        // against git-release — above all seventeen positives — because dividing by `Σ idf(q)` cancels
        // idf, so a match on `the` counted as much as a match on `pdf`.
        const ranked = bm25Selector("the the the the", CATALOGUE)
        expect(ranked.every((scored) => scored.score === 0)).toBe(true)
    })
})

describe("stopwords and stemming, both added after real data disagreed with the fixtures", () => {
    test("a query whose only corpus word is a function word selects nothing", () => {
        // Reproduced on the *shipped* reference workspace, which has three skills: `the` appeared in
        // exactly one of three descriptions, so `df <= total/2` let it through and "who won the 1998 world
        // cup" activated a CSV profiler at 0.446. `discriminating()` cannot fix this — at three documents
        // "more than half" is two — so function words are dropped outright.
        expect(top("who won the 1998 world cup")).toBeUndefined()
        expect(top("what is the capital of peru")).toBeUndefined()
    })

    test("an inflected description meets a base-form query", () => {
        // From `anthropics/skills`' real `pdf` description: "combining or merging", "rotating pages".
        // Without stemming the query below matched only `pdfs` and `page` — and `page` was in the *docx*
        // description, which is shorter, so docx won a question about rotating PDF pages.
        const best = top("merge three pdfs and rotate a page")
        expect(best?.name).toBe("pdf-processing")
    })
})

describe("known limitation: a generic verb in a description is a false-activation magnet", () => {
    test('a haiku request activates docker-build, because its description says "Write"', () => {
        // Asserted as current behaviour rather than hidden. Lexically this is not distinguishable from a
        // real match — the query and the description genuinely share their only discriminating term — so
        // no threshold fixes it: 0.446 sits inside the positive range of 0.390–0.633.
        //
        // Two things bound the cost, and one would fix it. `maxActive: 1` means an irrelevant procedure
        // displaces nothing, and the injected when-not-to-use tells the model it does not apply. The fix
        // is scoring when-not-to-use *negatively*, which needs a weighting constant nobody has measured.
        const best = top("write me a haiku about autumn")
        expect(best?.name).toBe("docker-build")
        expect(best?.score ?? 0).toBeGreaterThan(THRESHOLD)
        expect(best?.score ?? 0).toBeLessThan(0.6)
    })
})

describe("what is scored", () => {
    test("when-not-to-use is not part of the document, so it cannot attract its own negation", () => {
        // The deviation from the phase plan, as a test. A skill saying "not for scanned images — use
        // ocr-extract" must not be the top hit for a question about scanned images.
        const withNegative: readonly Skill[] = [
            {
                name: "pdf-processing",
                dir: "/skills/pdf-processing",
                tokens: 100,
                scripts: [],
                ignoredScripts: [],
                frontmatter: {
                    name: "pdf-processing",
                    description: "Extract text from PDF files.",
                    whenNotToUse: "Not for scanned images without a text layer — use ocr-extract.",
                    metadata: {},
                },
            },
            {
                name: "ocr-extract",
                dir: "/skills/ocr-extract",
                tokens: 100,
                scripts: [],
                ignoredScripts: [],
                frontmatter: {
                    name: "ocr-extract",
                    description: "Read text out of scanned images and photographs.",
                    metadata: {},
                },
            },
        ]
        const ranked = bm25Selector("get the text out of these scanned images", withNegative)
        expect(ranked[0]?.skill.name).toBe("ocr-extract")
    })

    test("the name is scored as well as the description", () => {
        const ranked = bm25Selector("sql-explain", CATALOGUE)
        expect(ranked[0]?.skill.name).toBe("sql-explain")
    })
})

describe("determinism", () => {
    test("identical scores break ties by name, on every machine", () => {
        // Three twins inside a corpus of six, so `widget` sits in exactly half and stays discriminating.
        // Three twins out of three would make every shared term appear in the whole corpus, which
        // `discriminating()` correctly refuses — and the first version of this test measured that instead
        // of the tiebreak it meant to.
        const twins: readonly Skill[] = ["b-skill", "a-skill", "c-skill"].map((name) => ({
            name,
            dir: `/skills/${name}`,
            tokens: 100,
            scripts: [],
            ignoredScripts: [],
            frontmatter: {
                name,
                description: "Handle widget calibration for the factory.",
                metadata: {},
            },
        }))
        const others: readonly Skill[] = ["x-skill", "y-skill", "z-skill"].map((name) => ({
            name,
            dir: `/skills/${name}`,
            tokens: 100,
            scripts: [],
            ignoredScripts: [],
            frontmatter: {
                name,
                description: "Reconcile invoices against purchase orders.",
                metadata: {},
            },
        }))
        const ranked = bm25Selector("widget calibration", [...twins, ...others])
        expect(ranked.slice(0, 3).map((scored) => scored.skill.name)).toEqual([
            "a-skill",
            "b-skill",
            "c-skill",
        ])
    })

    test("an empty catalogue ranks nothing rather than dividing by zero", () => {
        expect(bm25Selector("anything", [])).toEqual([])
    })
})

describe("the shared activation walk", () => {
    const sized = (tokens: number): { tokens: number; name: string } => ({
        tokens,
        name: `t${tokens}`,
    })

    test("maxActive caps the count", () => {
        const taken = activate([sized(10), sized(10), sized(10)], { maxActive: 2, budget: 1000 })
        expect(taken.length).toBe(2)
    })

    test("it stops at the first entry that does not fit and does not skip past it", () => {
        // The property both tiers depend on. Skipping the 900 to take the 10 would let a worse-ranked
        // entry displace a better-ranked one purely by being shorter.
        const taken = activate([sized(900), sized(10)], { maxActive: 5, budget: 100 })
        expect(taken).toEqual([])
    })

    test("maxActive of zero activates nothing", () => {
        expect(activate([sized(1)], { maxActive: 0, budget: 1000 })).toEqual([])
    })
})
