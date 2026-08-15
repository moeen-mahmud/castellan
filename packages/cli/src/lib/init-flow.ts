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

import { fillTemplate, WORKSPACE_TEMPLATES } from "#lib/templates"
import { BRAND } from "@castellan/core"

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
        modelId: "gpt-5-6-sol",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "anthropic",
        label: "Anthropic (OpenAI-compatible endpoint)",
        modelId: "claude-sonnet-5",
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "deepseek",
        label: "DeepSeek",
        modelId: "deepseek-v4-flash",
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
        label: "custom OpenAI-compatible endpoint or OpenRouter",
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
    /**
     * The env var the manifest names. Absent = the manifest omits the field entirely (a keyless
     * endpoint). Set from `--api-key-env` or the preset, never asked: which *variable* holds the
     * key is a detail of the generated file, and asking for it while asking for every other value
     * outright is the confusing shape this replaced.
     */
    readonly apiKeyEnv?: string
    /**
     * The key itself. Written to the gitignored `.env` beside the manifest, never to `agent.yaml`
     * — hard rule 10 is about what the *manifest* contains, and it still holds: the manifest names
     * the variable, this fills it in.
     *
     * Empty is a legitimate answer for anyone who exports the variable another way, and the next
     * steps keep saying so.
     */
    readonly apiKey?: string
    /**
     * How much of this machine the agent may touch: `none`, `read`, or `full`.
     *
     * Asked rather than left as a commented block, because the block was the bug. The generated
     * manifest named neither the provider nor the tools, so shell access was reachable only by
     * someone who already knew the field names — which is the opposite of what a generated file is
     * for. The answer writes real config, permission rules included, and `none` writes the same
     * block commented out so the shape is still there to uncomment.
     */
    readonly system: string
    /** Target directory, as given — the command resolves it against the cwd. */
    readonly dir: string
}

/**
 * What system access an agent may be given, and what each answer pins.
 *
 * Three rather than two because "can it read my files" and "can it change them" are genuinely
 * different questions, and collapsing them forces anyone who wants a reviewer or a summariser to
 * grant a shell they never needed.
 */
export const SYSTEM_CHOICES: readonly {
    readonly value: string
    readonly label: string
    readonly pinned: readonly string[]
    /** Mutating slugs that need an allow rule, or the first untrusted read gates them. */
    readonly allow: readonly string[]
}[] = [
    {
        value: "none",
        label: "No — it can talk and remember, and change its own settings when you ask",
        /**
         * Not empty, and the emptiness was the bug.
         *
         * With nothing pinned there is no provider, so `available()` is never called and the agent is
         * never told the file tools exist — asked to create a file it said "I don't have a tool that
         * touches your file system", which is true and useless. Asked to enable one it said the tools
         * are fixed at startup, which was also true and is the thing that was supposed to be fixed.
         *
         * So every level, including this one, can read its own configuration and change it when asked.
         * That is the whole of "it should always be able to update its own configuration" — and this is
         * the level where it matters most, because it is the only route out of it.
         */
        pinned: ["config_read", "config_set"],
        allow: ["memory_write", "config_set"],
    },
    {
        value: "read",
        label: "Read only — it can read and search files, but change nothing",
        // `config_read` on every level above `none`: without it the agent cannot tell you which
        // setting to change when a request needs a tool it does not have, which is the whole point of
        // telling it that the tool exists.
        pinned: ["file_read", "glob", "grep", "config_read", "config_set"],
        // `memory_write` is mutating and a file read taints the turn, so without this the agent
        // could read one file and then never save a note again for the rest of that turn.
        allow: ["memory_write", "config_set"],
    },
    {
        // The level that makes confinement *real*. `full` pins `exec`, and a shell carries its target
        // inside a string no path check can look inside — so the write root binds the file tools and
        // not the shell. Verified live: a full agent refused a `file_write` outside the root and then
        // did the same thing with `echo … >`. Anyone who wants "only inside workspace/, never
        // anywhere" and means it wants this level, and there was no way to ask for it.
        value: "write",
        label: "Read and write files — confined to its own workspace, no shell",
        pinned: [
            "file_read",
            "file_write",
            "file_edit",
            "glob",
            "grep",
            "config_read",
            "config_set",
        ],
        allow: ["memory_write", "file_write", "file_edit", "config_set"],
    },
    {
        value: "full",
        label: "Yes — read and write files, run commands, and change its own configuration",
        pinned: [
            "file_read",
            "file_write",
            "file_edit",
            "glob",
            "grep",
            "exec",
            "config_read",
            "config_set",
        ],
        allow: ["memory_write", "file_write", "file_edit", "exec", "config_set"],
    },
]

export function systemChoice(value: string) {
    return SYSTEM_CHOICES.find((choice) => choice.value === value)
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
    "apiKey",
    "system",
    "dir",
]

/**
 * Steps whose answer must never be echoed, logged, or shown in a summary.
 *
 * The renderer reads this rather than special-casing a slug, so a second secret question later
 * cannot be added without the masking coming with it.
 */
export const SECRET_STEPS: ReadonlySet<InitStep> = new Set<InitStep>(["apiKey"])

export interface Question {
    readonly step: InitStep
    /** One line, printed before the input prompt. */
    readonly prompt: string
    /** Offered default; empty string means the answer is required — unless `optional`. */
    readonly fallback: string
    /**
     * An empty answer is a real answer here, not a missing one.
     *
     * Stated rather than inferred from an empty fallback: those two things look identical and mean
     * opposite things to the non-interactive path, which must refuse for one and proceed for the
     * other.
     */
    readonly optional?: boolean
    /**
     * Present when the answer is one of a fixed set, which the renderer draws as a list rather than
     * a text field.
     *
     * On the question rather than hardcoded in the wizard: the preset menu was the only select for
     * three phases, and "is this the preset step" was written into the reducer, the renderer and the
     * cursor-prefill in three separate places. A second select had to either repeat all three or
     * generalise them, and generalising is what stops a third one repeating them again.
     */
    readonly options?: readonly { readonly value: string; readonly label: string }[]
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
        if (step === "apiKey" && preset !== undefined && preset.apiKeyEnv === undefined) {
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
                    // Short title plus `options`, rather than a prompt with the menu baked into it.
                    // The menu text was written for a renderer that never used it — the wizard drew
                    // its own list from PRESETS — so the choices lived in two places and only one of
                    // them was ever read. One source now, and `system` gets the same treatment for
                    // free rather than adding a second special case.
                    prompt: "Model endpoint",
                    fallback: "1",
                    options: PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
                }
            case "model":
                return { step, prompt: "Model id", fallback: preset?.modelId ?? "" }
            case "baseUrl":
                return { step, prompt: "Base URL", fallback: preset?.baseUrl ?? "" }
            case "apiKey":
                return {
                    step,
                    prompt: `Model API key`,
                    // Empty is allowed and means "I supply it another way" — the next steps then
                    // say where to put it. There is deliberately no flag for this: a key passed on
                    // the command line lands in shell history, which is why `--yes` takes the empty
                    // answer rather than refusing for want of one.
                    fallback: "",
                    optional: true,
                }
            case "system":
                return {
                    step,
                    prompt: "Can it act on this computer?",
                    fallback: "1",
                    options: SYSTEM_CHOICES.map((choice) => ({
                        value: choice.value,
                        label: choice.label,
                    })),
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

        case "apiKey":
            // Never rejected. Key formats differ per vendor and change without notice, so a shape
            // check here would refuse a valid key on the vendor's say-so — and the endpoint gives
            // an honest 401 on the first turn anyway. Empty means "not now".
            return { ok: true, value }

        case "system": {
            const byNumber = SYSTEM_CHOICES[Number(value) - 1]
            const chosen = byNumber ?? systemChoice(value.toLowerCase())
            return chosen === undefined
                ? {
                      ok: false,
                      reason: `pick 1-${SYSTEM_CHOICES.length}, or a name: ${SYSTEM_CHOICES.map((c) => c.value).join(", ")}.`,
                  }
                : { ok: true, value: chosen.value }
        }

        case "dir":
            return value === "" ? { ok: false, reason: "cannot be empty." } : { ok: true, value }
    }
}

/**
 * The `provider`/`pinned` half of the answer to "can it act on this computer?".
 *
 * `none` still writes the block, commented, with the exact lines to uncomment. That is the whole
 * point of the change: the previous template mentioned neither the provider nor a single tool slug,
 * so the only way to reach shell access was to already know the field names — and a generated file
 * that hides its own options is not doing the job a generated file exists to do.
 */
function systemBlock(system: string): readonly string[] {
    const choice = systemChoice(system) ?? SYSTEM_CHOICES[0]
    if (choice === undefined || choice.pinned.length === 0) {
        return [
            `  # ── acting on this computer ──`,
            `  # Nothing is enabled. Add tools here and permit them in the policy block below.`,
            `  # provider: system`,
            `  # pinned: [config_read, config_set]`,
        ]
    }

    const shell = choice.pinned.includes("exec")
    const files = choice.pinned.includes("file_read")

    // The configuration-only level. Everything the agent lacks is still named to it, so "I can't do
    // that" becomes "I can't do that yet, and here is the line that would let me" — and `config_set`
    // is what writes that line when you say go ahead.
    if (!files) {
        return [
            `  # ── acting on this computer ──`,
            `  # This agent cannot read, write or run anything. It CAN read this file and change it when`,
            `  # you ask — which is how you turn the rest on without editing YAML yourself.`,
            `  #`,
            `  # It is told which tools exist and are not enabled, so ask it for something it cannot do`,
            `  # and it will name the tool and offer to add it. A change takes effect on the next start.`,
            `  #`,
            `  # To enable them by hand instead, add to pinned:`,
            `  #   file_read, glob, grep      read and search files`,
            `  #   file_write, file_edit      change files, confined to workspace/`,
            `  #   exec                       run shell commands — the confinement does not bind it`,
            `  provider: system`,
            `  pinned:`,
            ...choice.pinned.map((slug) => `    - ${slug}`),
        ]
    }
    return [
        `  # ── acting on this computer ──`,
        shell
            ? `  # This agent can read and change files and run shell commands. What it may run is decided`
            : `  # This agent can read and search files and change nothing. Reading is still not nothing:`,
        shell
            ? `  # by the policy block below — narrow it, and prefer the file tools over the shell, whose`
            : `  # anything it reads can carry text a stranger wrote, which is why the write gate exists.`,
        ...(shell ? [`  # target a rule cannot see inside a command string.`] : []),
        `  #`,
        ...(shell
            ? [
                  `  # Writes are confined to workspace/ — add tools.providerConfig.writeRoots below to`,
                  `  # open another directory. That confinement binds the file tools and NOT exec, whose`,
                  `  # target lives inside a shell string no path check can see.`,
              ]
            : [
                  `  # Reading is not confined; changing things would be, but nothing here changes things.`,
              ]),
        `  provider: system`,
        `  pinned:`,
        ...choice.pinned.map((slug) => `    - ${slug}`),
        ...(shell
            ? [
                  `  # providerConfig:`,
                  `  #   writeRoots:`,
                  `  #     - ~/code/my-project    # absolute, or relative to this file's directory`,
              ]
            : []),
    ]
}

/**
 * The permission rules, and the `allow` entries without which the agent stops working mid-turn.
 *
 * Those entries look like they weaken the gate and are what makes it usable: a mutating call in a
 * turn that has already read a file needs a rule naming the tool, and a blanket `mode` is the
 * absence of one. Generated with the comment explaining what removing them costs, because the
 * alternative — a fresh agent that reads one file and then refuses to save a note — reads as a
 * broken runtime rather than as a security setting.
 */
function policyBlock(system: string): readonly string[] {
    const choice = systemChoice(system) ?? SYSTEM_CHOICES[0]
    const allow = choice?.allow ?? []
    const shell = choice?.pinned.includes("exec") === true

    const lines = [
        `  # ── which calls run, which ask, and which are refused ──`,
        `  # deny wins over allow, first match, and being more specific never reorders that. A rule`,
        `  # naming a primary content field — exec(command:rm *) — is refused at load, because a`,
        `  # compound command defeats it and a rule that can be defeated reads as protection.`,
        `  #`,
        `  # Below every setting here is a floor that cannot be lowered: rm -rf / and rm -rf ~,`,
        `  # --no-preserve-root, fork bombs, mkfs, and dd to a block device are never permitted.`,
        `  policy:`,
        `    mode: allow                 # allow | ask | deny — for calls no rule mentions`,
    ]

    if (allow.length === 0) {
        return [...lines, `    allow: []`, `    deny: []`, `    onNoApprover: deny`]
    }

    return [
        ...lines,
        `    # Authorises these even once untrusted content has entered the turn. Remove one and that`,
        `    # tool stops working for the rest of any turn that has read a file — which is the gate`,
        `    # doing its job, and worth choosing on purpose rather than discovering.`,
        `    allow:`,
        ...allow.map((slug) => `      - "${slug}"`),
        ...(shell
            ? [
                  `    deny:`,
                  `      # Narrow these to taste. A pattern matches the command, and every part of a`,
                  `      # compound must match for an allow — so "git status && rm -rf x" is not allowed`,
                  `      # by exec(git status:*).`,
                  `      - "exec(rm *)"`,
                  `      - "exec(sudo *)"`,
              ]
            : [`    deny: []`]),
        `    onNoApprover: deny          # what "ask" means with nobody to ask — a schedule, a pipe`,
    ]
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
        ...systemBlock(answers.system),
        ``,
        `  # ── a remote provider (Composio) ──`,
        `  # Run \`${BRAND.slug} tools ./agent.yaml --warm\` once before starting: resolution happens`,
        `  # during boot, where no network call is permitted, and a cold cache fails the load.`,
        `  # One provider at a time until tools.providers lands; swapping means replacing the block above.`,
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
        ...policyBlock(answers.system),
        ``,
        `  # ── the write gate ──`,
        `  # A tool whose output came from outside this conversation taints the turn. After that, a`,
        `  # tool that CHANGES something needs explicit authorisation — one of the allow rules above,`,
        `  # or a live approval. "refuse" never prompts, which is what makes it right for a schedule.`,
        `  untrusted:`,
        `    onMutate: refuse            # refuse | confirm | allow`,
        ``,
        `  # ── web search and page fetching — arrives with the rest of Phase 3.6 ──`,
        `  # web:`,
        `  #   backend: tavily             # tavily | brave | exa`,
        `  #   apiKeyEnv: TAVILY_API_KEY`,
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
        // The value the wizard collected, or an empty line to fill in. This file is gitignored and
        // sits beside the manifest, which is the whole point: the manifest names the variable, the
        // key lives here. A key is still never accepted as a command-line flag — that writes it
        // into shell history — so the scripted path leaves this blank and the next steps say so.
        lines.push(`${answers.apiKeyEnv}=${answers.apiKey ?? ""}`)
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
