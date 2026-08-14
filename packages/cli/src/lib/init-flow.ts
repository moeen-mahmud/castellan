/**
 * The init wizard's question flow and file plan — pure data in, pure data out.
 *
 * Deliberately renderer-free and process-free (it is in the boundaries test's PURE list): the
 * readline loop in `init.ts` is one consumer, a flag-driven non-interactive run is another, and
 * an Ink wizard would be a third if one ever pays for itself. The flow cannot know which is
 * driving it, which is what keeps the three from diverging.
 *
 * Generated text carries two kinds of content. Everything *structural* — identity, voice, rules,
 * policy — is genuinely filled from the answers, so the agent runs and validates immediately.
 * The three dialogue examples keep their `{{INPUT_n}}`/`{{REPLY_n}}` placeholders on purpose:
 * examples are the highest-leverage section of an identity file and stock ones teach a stock
 * voice, so the `workspace` command keeps warning until a person writes real exchanges.
 */

import { BRAND } from "@castellan/core"
import { fillTemplate, WORKSPACE_TEMPLATES } from "#lib/templates"

/**
 * The local tools every generated agent starts with, and the one line of guidance each carries
 * into the generated manifest and the wizard's tools screen — single-sourced so the two cannot
 * drift, and pinned by a test to core's `LOCAL_TOOL_SLUGS` so a new local tool cannot ship
 * without init knowing.
 */
export const INIT_LOCAL_TOOLS: readonly { readonly slug: string; readonly note: string }[] = [
    { slug: "now", note: "read-only: runs in parallel with other reads" },
    {
        slug: "memory_write",
        note: "mutating: serialises, holds a reserved write slot, never retried",
    },
]

/** Exported so the drift test can compare against core without re-deriving the mapping. */
export const INIT_LOCAL_TOOL_SLUGS: readonly string[] = INIT_LOCAL_TOOLS.map((tool) => tool.slug)

export type PresetId = "openai" | "anthropic" | "deepseek" | "ollama" | "custom"

export interface Preset {
    readonly id: PresetId
    readonly label: string
    /** Empty for `custom`, which has no defaults to offer. */
    readonly modelId: string
    readonly baseUrl: string
    /** Absent means the manifest omits `apiKeyEnv` entirely — a keyless local endpoint. */
    readonly apiKeyEnv?: string
}

/**
 * The same presets the examples' `.env.example` documents, plus Ollama, which the examples only
 * mention in prose. `custom` exists so an unlisted endpoint is a first-class answer rather than
 * a fight with the nearest preset.
 */
export const PRESETS: readonly Preset[] = [
    {
        id: "openai",
        label: "OpenAI",
        modelId: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "anthropic",
        label: "Anthropic (OpenAI-compatible endpoint)",
        modelId: "claude-sonnet-4-20250514",
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "deepseek",
        label: "DeepSeek",
        modelId: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "ollama",
        label: "Ollama (local, no key)",
        modelId: "qwen3.5:9b",
        baseUrl: "http://localhost:11434/v1",
    },
    {
        id: "custom",
        label: "custom OpenAI-compatible endpoint",
        modelId: "",
        baseUrl: "",
        apiKeyEnv: "MODEL_API_KEY",
    },
] as const

export function presetById(id: string): Preset | undefined {
    return PRESETS.find((preset) => preset.id === id)
}

export interface InitAnswers {
    /** The person's name. */
    readonly user: string
    /** The agent's name. Drives the manifest `id` and the default directory. */
    readonly name: string
    /** One line: what the agent is for. */
    readonly purpose: string
    readonly preset: PresetId
    readonly model: string
    readonly baseUrl: string
    /** Absent = the manifest omits the field (keyless endpoint). */
    readonly apiKeyEnv?: string
    /** Target directory, as given — the command resolves it against the cwd. */
    readonly dir: string
}

export type InitStep = keyof InitAnswers

/**
 * Answers as they accumulate: every step is a string until `complete` narrows them, because they
 * arrive from readline and flags as text and are validated per step, not per type.
 */
export type PartialAnswers = Partial<Record<InitStep, string>>

/** The asking order. `apiKeyEnv` is skipped when the chosen preset is keyless. */
const STEP_ORDER: readonly InitStep[] = [
    "user",
    "name",
    "purpose",
    "preset",
    "model",
    "baseUrl",
    "apiKeyEnv",
    "dir",
]

export interface Question {
    readonly step: InitStep
    /** One line, printed before the input prompt. */
    readonly prompt: string
    /** Offered default; empty string means the answer is required. */
    readonly fallback: string
}

/**
 * The manifest `id` and default directory name, from the agent's name.
 *
 * Kebab-case because the id is a slug (session keys, API paths) and the directory is typed into
 * shells. A name that reduces to nothing ("!!!") falls back to "agent" rather than producing an
 * invalid id.
 */
export function slugify(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    return slug === "" ? "agent" : slug
}

/**
 * The next unanswered question, or undefined when the flow is complete.
 *
 * Model and base URL default from the chosen preset, so at a TTY the happy path is naming two
 * people and pressing return a few times. `custom` offers no defaults — an unlisted endpoint has
 * nothing honest to prefill.
 */
export interface QuestionDefaults {
    /**
     * Where agents live when nobody says otherwise — the command layer passes the sandbox's
     * agents directory. Passed in rather than computed because this module is PURE: it may not
     * touch the filesystem, the home directory, or the environment.
     */
    readonly agentDirBase?: string
}

export function nextQuestion(
    partial: PartialAnswers,
    defaults: QuestionDefaults = {},
): Question | undefined {
    const preset = partial.preset === undefined ? undefined : presetById(partial.preset)

    for (const step of STEP_ORDER) {
        if (partial[step] !== undefined) continue
        // A keyless preset asks no key question. An explicit --api-key-env still lands in
        // `partial` before this runs, so the deliberate keyed-proxy override survives the skip.
        if (step === "apiKeyEnv" && preset !== undefined && preset.apiKeyEnv === undefined) {
            continue
        }

        switch (step) {
            case "user":
                return { step, prompt: "Your name", fallback: "" }
            case "name":
                return { step, prompt: "The agent's name", fallback: "" }
            case "purpose":
                return {
                    step,
                    prompt: "What is it for, in one line",
                    fallback: "helping with whatever comes up",
                }
            case "preset":
                return {
                    step,
                    prompt: presetMenu(),
                    fallback: "1",
                }
            case "model":
                return { step, prompt: "Model id", fallback: preset?.modelId ?? "" }
            case "baseUrl":
                return { step, prompt: "Base URL", fallback: preset?.baseUrl ?? "" }
            case "apiKeyEnv":
                return {
                    step,
                    prompt: "Env var that will hold the API key",
                    fallback: preset?.apiKeyEnv ?? "MODEL_API_KEY",
                }
            case "dir":
                return {
                    step,
                    prompt: "Directory to create",
                    // Plain "/" concatenation is deliberate: node's fs accepts it on every
                    // platform, and a PURE module cannot import node:path to join.
                    fallback:
                        partial.name === undefined
                            ? ""
                            : defaults.agentDirBase === undefined
                              ? `./${slugify(partial.name)}`
                              : `${defaults.agentDirBase}/${slugify(partial.name)}`,
                }
        }
    }

    return undefined
}

function presetMenu(): string {
    const lines = PRESETS.map((preset, index) => `  ${index + 1}) ${preset.label}`)
    return `Model endpoint\n${lines.join("\n")}\nchoice`
}

export type Answered =
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly reason: string }

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

/**
 * Per-step validation, with the loader's own rules applied early.
 *
 * The base-URL checks are the same two `manifest/validate.ts` enforces at load — failing here,
 * at the question, beats generating a directory whose first validate names the mistake back.
 */
export function validateAnswer(step: InitStep, raw: string): Answered {
    const value = raw.trim()

    switch (step) {
        case "user":
        case "name":
        case "model":
        case "purpose":
            return value === "" ? { ok: false, reason: "cannot be empty." } : { ok: true, value }

        case "preset": {
            const byNumber = PRESETS[Number(value) - 1]
            const chosen = byNumber ?? presetById(value.toLowerCase())
            return chosen === undefined
                ? {
                      ok: false,
                      reason: `pick 1-${PRESETS.length}, or a name: ${PRESETS.map((p) => p.id).join(", ")}.`,
                  }
                : { ok: true, value: chosen.id }
        }

        case "baseUrl": {
            let url: URL
            try {
                url = new URL(value)
            } catch {
                return {
                    ok: false,
                    reason: "must be an absolute URL, e.g. https://api.example.com/v1.",
                }
            }
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                return { ok: false, reason: "only http and https are supported." }
            }
            if (url.pathname.endsWith("/chat/completions")) {
                return {
                    ok: false,
                    reason: "must end at the version segment — the runtime appends /chat/completions itself.",
                }
            }
            return { ok: true, value }
        }

        case "apiKeyEnv":
            return ENV_NAME.test(value)
                ? { ok: true, value }
                : { ok: false, reason: "must be an env var name, like MODEL_API_KEY." }

        case "dir":
            return value === "" ? { ok: false, reason: "cannot be empty." } : { ok: true, value }
    }
}

export interface GeneratedFile {
    /** Relative to the target directory. */
    readonly relPath: string
    readonly contents: string
}

/**
 * The full file plan. Pure — the command decides where it lands and whether anything exists.
 *
 * Identity and operations are different files, per the split the wider ecosystem converged
 * on (OpenClaw, soul.md): the soul pair answers *who the agent is*, AGENTS.md answers *what
 * it does and how* — responsibilities, workflow, the memory procedure, and eventually the
 * team routing. They coexist; what must not exist is a second *identity* document.
 */
export function planFiles(answers: InitAnswers): readonly GeneratedFile[] {
    const substitutions = substitutionsFor(answers)
    return [
        { relPath: "agent.yaml", contents: manifestFor(answers) },
        ...(
            [
                "SOUL.md",
                "SOUL.compact.md",
                "AGENTS.md",
                "POLICY.md",
                "USER.md",
                "MEMORY.md",
                "REMINDER.md",
            ] as const
        ).map((name) => ({
            relPath: `workspace/${name}`,
            contents: fillTemplate(WORKSPACE_TEMPLATES[name], substitutions),
        })),
        { relPath: ".env.example", contents: envExampleFor(answers) },
        { relPath: ".env", contents: envFor(answers) },
        // The generated .env carries real endpoint values and eventually a key; a repo-ready
        // directory that would commit it by default is a trap. Kept even in the sandbox —
        // people run `git init` there too.
        { relPath: ".gitignore", contents: ".env\n" },
    ]
}

/**
 * What fills the templates.
 *
 * The wording descends from the filled reference workspace, with pronouns replaced by the
 * user's name — a generated file must not guess anyone's pronouns. The dialogue examples'
 * `INPUT_n`/`REPLY_n` are deliberately absent from this map: they stay placeholders until a
 * person writes real exchanges, and the `workspace` command keeps saying so.
 *
 * Every sentence here is audited against the rule counter (`workspace/rules.ts`): the prose
 * avoids obligation markers and imperative openers, so whichever identity file the soul gate
 * ships, the counted total is 1 (RULE_HONESTY's "don't") against the default budget of 2 —
 * a test pins this, because one synonym swap ("never guess") would silently bust it. Three
 * rules ship; the counter's keyword heuristic sees one, and that is fine — the budget guards
 * against obligation *density*, and the pin is what notices if a rewrite changes the count.
 */
function substitutionsFor(answers: InitAnswers): Record<string, string> {
    const { user, name, purpose } = answers
    // One line each — the rule counter is line-based, and these three survive distillation
    // verbatim into every model's context. REMINDER reuses the confirm rule byte-for-byte:
    // two phrasings of one rule read as two rules. The memory rule exists because the gap
    // it closes was observed, not imagined: a generated agent told a durable fact answered
    // warmly and saved nothing, and the recall the person then saw came from session
    // history — which evaporates on a fresh session. The tool catalogue's whenToUse alone
    // did not move a frontier model to save; the identity file is what sets behaviour.
    const ruleConfirm = `I confirm before anything that sends, spends, schedules, or deletes, because I'm wired into live systems and mistakes there are expensive.`
    const ruleHonesty = `When I don't know something I say so and offer to go find out, rather than producing something plausible and letting ${user} discover the difference later.`
    const ruleMemory = `When ${user} tells me something worth keeping — a fact about them, a preference, a decision — I save it with memory_write in the same turn, because the conversation is not memory and a new session starts without it.`

    return {
        AGENT_NAME: name,
        USER: user,
        RULE_CONFIRM: ruleConfirm,
        RULE_HONESTY: ruleHonesty,
        RULE_MEMORY: ruleMemory,

        SOUL_WHO:
            `I'm ${name}. I work with ${user}, and this is what I'm for: ${purpose}. ` +
            `The relationship is the point — I'm not a search box; I'm closer to a colleague ` +
            `who holds context so ${user} doesn't have to.`,
        SOUL_MEASURE:
            `The measure of whether I'm working is not how impressive my answers are — it's ` +
            `whether ${user}'s day runs smoother because I was in it.`,
        SOUL_ANSWERS:
            `I lead with the answer and put the reasoning after it, when the reasoning is worth ` +
            `having. Disagreement is part of the job: if I think an idea is bad I say so once, ` +
            `plainly, with the reason, and then help with it anyway if ${user} still wants it. ` +
            `When I'm unsure I name the part I'm unsure about instead of hedging the whole ` +
            `answer into mush — an unhelpful answer isn't the safe one, it just moves the cost ` +
            `somewhere ${user} can't see it.`,
        SOUL_VOICE:
            `I write the way people write to each other: plain sentences, no headers, no bullet ` +
            `lists unless there's genuinely a list. Short is a courtesy. I skip performed ` +
            `enthusiasm and padded pleasantries — warmth, where it shows, is in remembering ` +
            `things ${user} didn't ask me to remember.`,
        SOUL_REFUSE:
            `A yes-machine. The moment I optimise for sounding agreeable over being right, I ` +
            `stop being worth talking to.`,

        SOUL_COMPACT_WHO:
            `I'm ${name}. I work with ${user} — ${purpose}. The measure of whether I'm working ` +
            `is whether ${user}'s day runs smoother because I was in it.`,
        SOUL_COMPACT_ANSWERS:
            `I lead with the answer and put the reasoning after it. When I'm unsure I name the ` +
            `part I'm unsure about instead of hedging the whole answer into mush.`,
        SOUL_COMPACT_VOICE:
            `I write plain sentences: no headers, no bullet lists unless there's genuinely a ` +
            `list. Short is a courtesy.`,

        // AGENTS.md — operations, deliberately personality-free. Declarative first person
        // throughout ("I check…", never "Check…"): an imperative opener or a modal would
        // count against the same rule budget as the soul's <rules> block.
        RESPONSIBILITIES:
            `My job: ${purpose}. A task ${user} hands me stays mine until it's done, handed ` +
            `back, or blocked — and when it's blocked, ${user} hears what's blocking it ` +
            `rather than silence.`,
        WORKFLOW:
            `I look at what I already know — the files in my context and what ${user} told me ` +
            `earlier — before asking ${user} to repeat themselves. For anything with more than ` +
            `one step I say the plan in a line first, so a wrong direction costs one message ` +
            `instead of the whole job. Work that touches live systems goes through the ` +
            `confirmation rule in my identity file.`,
        MEMORY_PROCEDURE:
            `Durable facts about ${user} — names, dates, preferences, decisions — go through ` +
            `memory_write the moment I learn them, into my workspace files. Those files come ` +
            `back to me automatically each turn; when a saved note and what ${user} just said ` +
            `disagree, the person wins and the note gets corrected.`,

        BOUNDARIES:
            `If something involves a person other than ${user}, I ask what they want shared ` +
            `before including it — ${user} knows the relationship and I don't.`,
        UNCERTAINTY_BEHAVIOUR:
            `When I can't reach a tool or a request is ambiguous, I say which part is unclear ` +
            `and ask, because guessing just moves the cost somewhere ${user} can't see it.`,
        USER_FACTS: `${user} is the person I work for.\nWhat they brought me in for: ${purpose}.`,
        REMINDER_RULE: ruleConfirm,
    }
}

/**
 * The generated manifest, in the reference style: everything init configured is live, and
 * everything a later phase delivers is present but commented, labelled with its phase — so the
 * file teaches its own surface. A commented section is REFUSED AT LOAD if uncommented before its
 * phase ships; the runtime never silently ignores configuration.
 *
 * Every mention of the binary interpolates `BRAND.slug` (hard rule 3), and the endpoint values
 * live in `.env` so switching providers never edits this file.
 */
function manifestFor(answers: InitAnswers): string {
    const slug = slugify(answers.name)
    const rule = (title: string): string =>
        `# ── ${title} ${"─".repeat(Math.max(1, 88 - title.length))}`

    const lines = [
        `# ${answers.name} — generated by \`${BRAND.slug} init\`.`,
        `#`,
        `# Everything active below is what init configured; everything commented arrives with the`,
        `# phase named beside it, and is REFUSED AT LOAD if uncommented early — the runtime never`,
        `# silently ignores configuration. docs/02-SPEC-MANIFEST.md is the binding reference.`,
        ``,
        `apiVersion: ${BRAND.apiVersion}`,
        `id: ${slug}`,
        `name: ${answers.name}`,
        ``,
        rule("model"),
        `model:`,
        `  main:`,
        `    # The values live in .env beside this file, so switching endpoints never edits it.`,
        `    id: \${MODEL_ID}`,
        `    # Must end at the version segment; the runtime appends /chat/completions itself.`,
        `    baseUrl: \${MODEL_BASE_URL}`,
    ]
    if (answers.apiKeyEnv !== undefined) {
        lines.push(
            `    # The *name* of an env var, never a value — a literal key fails validation.`,
            `    apiKeyEnv: ${answers.apiKeyEnv}`,
        )
    }
    lines.push(
        `    temperature: 0.3`,
        `    # reasoningEffort: none   # none | minimal | low | medium | high — a reasoning model`,
        `    #                         # bills its thinking to the output budget; verify per endpoint`,
        `    # topP: 0.95`,
        `    # maxTokens: 4096`,
        `    # streamUsage: true       # OpenAI extension; needed for real token counts on Ollama`,
        `    # Override the shipped capability registry only when it is wrong for your endpoint.`,
        `    # capabilities:`,
        `    #   contextWindow: 32768`,
        `    #   thinking: none        # none | anthropic | openai | deepseek`,
        `    #   promptStyle:          # how workspace files render for this model (Phase 3.5)`,
        `    #     delimiters: plain   # xml | markdown | plain`,
        `    #     intensity: emphatic # emphatic | neutral | soft`,
        ``,
        `  # A cheap model for tool selection and summarisation. \`$ref\` reuses a role.`,
        `  # selector:`,
        `  #   id: \${SELECTOR_MODEL_ID}`,
        `  #   baseUrl: \${MODEL_BASE_URL}`,
        `  # compactor: { $ref: model.selector }`,
        ``,
        rule("context"),
        `context:`,
        `  workspace: ./workspace`,
        ``,
        `  # Tier 0 — cached, read-only. Identity is NOT listed here: the soul below (or its`,
        `  # distilled compact file) ships it. AGENTS.md is operations — what the agent does,`,
        `  # not who it is — which is why the two coexist.`,
        `  static:`,
        `    - AGENTS.md`,
        `    - POLICY.md`,
        ``,
        `  # Tier 1 — after the cache breakpoint, so a memory write never invalidates the prefix.`,
        `  volatile:`,
        `    - USER.md`,
        `    - MEMORY.md`,
        ``,
        `  # Tier 2 — re-asserted after the history, where attention is strongest.`,
        `  reminder: REMINDER.md`,
        ``,
        `  # Generous because a reasoning model bills its thinking here too.`,
        `  reserveOutput: 8192`,
        ``,
        `  # Capability-gated identity: SOUL.md ships only to a model meeting \`requires\`; anything`,
        `  # else gets the hand-edited compact file. Edit SOUL.md first, then re-derive`,
        `  # SOUL.compact.md to match — never the reverse.`,
        `  soul:`,
        `    file: SOUL.md`,
        `    requires: { contextWindow: ">=200000", class: frontier }`,
        `    onUnmet: distill`,
        `    distilled: SOUL.compact.md`,
        ``,
        `  # Defaults shown; uncomment to change. Budgets fail the load naming the file — never`,
        `  # silent truncation.`,
        `  # observationMaxTokens: 2000`,
        `  # budgets: { static: 2000, volatile: 3500, reminder: 500, total: 6000 }`,
        `  # rules:`,
        `  #   perRuleSuccess: 0.90    # measure with \`${BRAND.slug} eval rules\`, do not guess`,
        `  #   reliabilityTarget: 0.80 # at 0.90 per rule this permits TWO rules, not four`,
        `  #   onExceed: fail`,
        ``,
        rule("tools"),
        `tools:`,
        `  # Config only, never auto-detected: behaviour must not drift when the model changes.`,
        `  dialect: nlt`,
        ``,
        `  # Built-in tools, resolved from memory. Never sent to a remote provider.`,
        `  local:`,
        ...INIT_LOCAL_TOOLS.map((tool) => `    - ${tool.slug.padEnd(14)}# ${tool.note}`),
        ``,
        `  budget:`,
        `    max: 24`,
        `    reserveWrite: 6   # slots held for mutating tools so reads cannot starve writes`,
        ``,
        `  # ── a remote provider (Composio) ──`,
        `  # Run \`${BRAND.slug} tools ./agent.yaml --warm\` once before starting: resolution happens`,
        `  # during boot, where no network call is permitted, and a cold cache fails the load.`,
        `  # provider: composio`,
        `  # providerConfig:`,
        `  #   apiKeyEnv: COMPOSIO_API_KEY   # the variable's name, never the key`,
        `  #   userId: me`,
        `  # pinned:`,
        `  #   - GMAIL_FETCH_EMAILS`,
        `  #   - GOOGLECALENDAR_EVENTS_LIST`,
        ``,
        `  # tools.search finds a TOOL in the provider's catalogue — nothing to do with web search.`,
        `  # Off by design in v1: search-then-execute is two-hop reasoning, where small models fail.`,
        `  search:`,
        `    enabled: false`,
        ``,
        `  # ── Phase 3.6: web search and page fetching — untrusted output is delimited as data ──`,
        `  # web:`,
        `  #   backend: tavily             # tavily | brave | exa`,
        `  #   apiKeyEnv: TAVILY_API_KEY`,
        `  # untrusted:`,
        `  #   onMutate: refuse            # refuse | confirm | allow`,
        ``,
        rule("limits"),
        `limits:`,
        `  # A two-tool chain needs five steps (call, observe, call, observe, reply); one spare.`,
        `  maxSteps: 6`,
        `  turnTimeoutMs: 120000`,
        `  toolTimeoutMs: 30000`,
        ``,
        rule("later phases — refused at load until they ship"),
        `# Phase 7 — phase-scoped tool visibility (the strongest published small-model lever):`,
        `# phases:`,
        `#   triage: { entry: true, allow: ["now"] }`,
        `#   act:    { allow: ["*"] }`,
        ``,
        `# Phase 5 — skills:`,
        `# skills: { dir: ./skills, maxActive: 1, threshold: 0.35 }`,
        ``,
        `# Phase 3.5 — knowledge, keyword-gated and never pinned (create ./knowledge first):`,
        `# knowledge: { dir: ./knowledge, maxActive: 2, budget: 600 }`,
        ``,
        `# Phase 6 — memory:`,
        `# memory: { retriever: fts5, dir: ./memory, k: 6, includeHistory: true }`,
        ``,
        `# Phase 4 — channels, delivery, and the HTTP server:`,
        `# channels:`,
        `#   - type: telegram`,
        `#     id: tg`,
        `#     tokenEnv: TELEGRAM_BOT_TOKEN`,
        `#     allowFrom: ["@your-handle"]`,
        `# delivery:`,
        `#   default: tg`,
        `# server:`,
        `#   enabled: true`,
        `#   host: 127.0.0.1`,
        `#   port: 7420`,
        `#   tokenEnv: ${BRAND.envPrefix}API_TOKEN`,
        ``,
        `# Phase 8 — schedules:`,
        `# schedules:`,
        `#   - id: morning-brief`,
        `#     kind: cron`,
        `#     expr: "0 8 * * *"`,
        `#     task: "Summarise the day ahead."`,
        `#     deliver: { channel: tg, to: "@your-handle" }`,
        ``,
        `# Phase 9 — plugins:`,
        `# plugins:`,
        `#   - "${BRAND.packageScope}/channel-telegram"`,
        ``,
    )
    return lines.join("\n")
}

function envFor(answers: InitAnswers): string {
    const lines = [
        `# Values for the \${...} references in agent.yaml. Gitignored — real keys live here.`,
        `MODEL_ID=${answers.model}`,
        `MODEL_BASE_URL=${answers.baseUrl}`,
    ]
    if (answers.apiKeyEnv !== undefined) {
        // Deliberately left empty: the wizard never asks for the secret. Typing a key into a
        // prompt invites shoulder-surfing; passing it as a flag writes it into shell history.
        lines.push(`${answers.apiKeyEnv}=`)
    }
    return `${lines.join("\n")}\n`
}

function envExampleFor(answers: InitAnswers): string {
    const sections = PRESETS.filter((preset) => preset.id !== "custom").map((preset) => {
        const active = preset.id === answers.preset
        const mark = active ? "" : "# "
        const key =
            preset.apiKeyEnv === undefined
                ? `${mark}# no key — apiKeyEnv is omitted from agent.yaml for this endpoint`
                : `${mark}${answers.apiKeyEnv ?? preset.apiKeyEnv}=`
        return [
            `# ── ${preset.label} ${"─".repeat(Math.max(1, 60 - preset.label.length))}`,
            `${mark}MODEL_ID=${preset.modelId}`,
            `${mark}MODEL_BASE_URL=${preset.baseUrl}`,
            key,
        ].join("\n")
    })

    return `${[
        `# Copy to .env beside the manifest. The real environment always wins over this file.`,
        `# Pick one preset — the manifest does not change between them.`,
        ``,
        sections.join("\n\n"),
    ].join("\n")}\n`
}
