/**
 * The curated list: what `skills` shows before anybody types a query.
 *
 * ## Why a catalogue needs curating at all
 *
 * `anthropics/skills` is 17 skills and every one of them is broadly useful, so it ships whole.
 * `github/awesome-copilot` is **425**, and the great majority are developer tooling — Azure resource
 * naming, language-specific refactorings, IDE plugin scaffolds. Showing all 442 as a browsable list is
 * not a catalogue, it is a directory listing, and the person who opens it has to already know what they
 * are looking for. Which was the original problem.
 *
 * So the community source has an allowlist and the anthropic source does not. The entries below are the
 * subset that is useful to somebody running an agent rather than writing one: specs and planning,
 * documents, communications, go-to-market, diagrams, prompt craft, research.
 *
 * ## Verified against upstream, and one name removed
 *
 * Every folder here was checked against `github/awesome-copilot`'s tree on 2026-08-17. Of the 38 first
 * drafted, **37 exist and `prompt-builder` does not** — and that is the failure mode this comment is here
 * to prevent, because a name that matches no folder is silently absent from the list rather than an error.
 * `npm run check:curated`-style verification is `sources search --json` plus a diff; the test in
 * `curated.test.ts` asserts the shape, not the remote, so it cannot start failing when upstream renames
 * something. **Re-check by hand when adding entries.**
 *
 * Curation applies to *browsing*, never to searching. `sources search` reaches all 442 on purpose: a
 * curated list is a recommendation, and refusing to find a skill somebody knows the name of would make
 * curation a restriction. Two different questions — "what should I look at" and "is this thing here".
 */

/** One group in the browse list. Order is the order on screen. */
export interface CuratedGroup {
    readonly title: string
    readonly skills: readonly string[]
}

export const CURATED_COMMUNITY: readonly CuratedGroup[] = [
    {
        title: "Specs and planning",
        skills: [
            "prd",
            "breakdown-feature-prd",
            "breakdown-epic-pm",
            "breakdown-feature-implementation",
            "breakdown-plan",
            "create-implementation-plan",
            "create-specification",
            "create-architectural-decision-record",
            "create-technical-spike",
        ],
    },
    {
        title: "Documents",
        skills: [
            "create-readme",
            "create-tldr-page",
            "documentation-writer",
            "convert-plaintext-to-md",
            "markdown-to-html",
        ],
    },
    {
        title: "Communications",
        skills: ["meeting-minutes", "email-drafter", "linkedin-post-formatter", "daily-prep"],
    },
    {
        title: "Go to market",
        skills: [
            "gtm-0-to-1-launch",
            "gtm-board-and-investor-communication",
            "gtm-enterprise-account-planning",
            "gtm-enterprise-onboarding",
            "gtm-operating-cadence",
            "gtm-partnership-architecture",
            "gtm-positioning-strategy",
            "gtm-product-led-growth",
            "gtm-technical-product-pricing",
            "gtm-developer-ecosystem",
        ],
    },
    {
        title: "Team and process",
        skills: ["mentoring-juniors", "impediment-prioritization", "quality-playbook"],
    },
    {
        title: "Diagrams",
        skills: [
            "napkin",
            "excalidraw-diagram-generator",
            "draw-io-diagram-generator",
            "plantuml-ascii",
        ],
    },
    {
        // `prompt-builder` was drafted here and does not exist upstream. Left as a comment rather than
        // deleted, so the next person to add it checks first.
        title: "Prompt craft and research",
        skills: ["boost-prompt", "autoresearch"],
    },
]

/** Flat allowlist, for the catalogue filter. */
export const CURATED_COMMUNITY_SKILLS: readonly string[] = CURATED_COMMUNITY.flatMap(
    (group) => group.skills,
)

/**
 * Which group a curated skill belongs to, for the browse list's headers.
 *
 * Anything not in the map — every anthropic skill, and anything reached by search — falls into the
 * source's own heading rather than being hidden.
 */
export function curatedGroupOf(skill: string): string | undefined {
    return CURATED_COMMUNITY.find((group) => group.skills.includes(skill))?.title
}
