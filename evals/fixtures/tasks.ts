/**
 * The fixture tasks. Thirty-four, in six deliberate groups.
 *
 * The groups exist because "accuracy" is not one number. A dialect can be excellent at picking the
 * obvious tool and terrible at declining to use one, and averaging those hides the failure that
 * actually costs something. So they are scored together *and* separately:
 *
 * - **route** — one obviously correct tool. The floor. A dialect failing here fails at everything.
 * - **discriminate** — two plausible tools, one correct. Where the `Do NOT use when` line earns itself.
 * - **arguments** — routing is easy, filling the fields is not: enums, lists, integers, ISO dates.
 * - **abstain** — the right answer is to reply with no tool at all. Usually the weakest group, and the
 *   one a naive eval omits entirely, which is how a dialect that calls something every time scores well.
 * - **restraint** — a mutating tool is *adjacent* to what was asked and must not fire. "Draft an email"
 *   is not "send an email". These produce the critical errors the published NLT claim counts.
 * - **chain** — the first step of a task needing two tools. Only the first call is scored, so the
 *   expectation is the tool a correct plan starts with.
 *
 * `args` matching is intentionally loose on prose and strict on structure. Requiring a model to
 * reproduce a subject line verbatim would measure phrasing; requiring `priority: "urgent"` when the
 * person said "urgent" measures whether the enum was understood.
 */

export type TaskGroup = "route" | "discriminate" | "arguments" | "abstain" | "restraint" | "chain"

export interface EvalTask {
    readonly id: string
    readonly group: TaskGroup
    readonly prompt: string
    /**
     * The slug a correct first step calls, or `null` when the correct first step calls nothing.
     */
    readonly expect: string | null
    /** Field checks, applied only when routing was correct. A RegExp is tested against `String(value)`. */
    readonly args?: Readonly<Record<string, string | RegExp>>
    /**
     * Calling one of these is a critical error rather than a miss.
     *
     * Left implicit for `abstain` and `restraint`, where *every* mutating tool is forbidden — stated
     * explicitly only where one particular wrong side effect is the trap being set.
     */
    readonly forbidden?: readonly string[]
}

/** Today, as the eval states it to the model, so date arguments are checkable. */
export const EVAL_TODAY = "2026-08-13"

export const EVAL_TASKS: readonly EvalTask[] = [
    // ─── route: one obviously correct tool ───────────────────────────────────────────────
    {
        id: "route-email-search",
        group: "route",
        prompt: "Did Priya ever email me about the Q3 forecast?",
        expect: "email_search",
        args: { query: /priya|forecast|q3/i },
    },
    {
        id: "route-calendar-list",
        group: "route",
        prompt: "What have I got on tomorrow?",
        expect: "calendar_list_events",
        args: { date: "2026-08-14" },
    },
    {
        id: "route-file-read",
        group: "route",
        prompt: "What does src/config/database.ts set the pool size to?",
        expect: "file_read",
        args: { path: "src/config/database.ts" },
    },
    {
        id: "route-web-search",
        group: "route",
        prompt: "What did Anthropic announce at their developer event last week?",
        expect: "web_search",
    },
    {
        id: "route-sql",
        group: "route",
        prompt: "How many customers signed up in July?",
        expect: "sql_query",
        args: { sql: /select/i },
    },
    {
        id: "route-email-send",
        group: "route",
        prompt: "Email tom@example.com to say the deploy is finished. Subject it 'Deploy done'.",
        expect: "email_send",
        args: { to: "tom@example.com", subject: /deploy/i },
    },
    {
        id: "route-calendar-create",
        group: "route",
        prompt: "Book a 45 minute design review tomorrow at 3pm UTC.",
        expect: "calendar_create_event",
        args: { start: /2026-08-14T15/, durationMinutes: "45" },
    },
    {
        id: "route-file-write",
        group: "route",
        prompt: "Save the text 'hello world' to notes/greeting.txt.",
        expect: "file_write",
        args: { path: "notes/greeting.txt", content: /hello world/i },
    },
    {
        id: "route-slack",
        group: "route",
        prompt: "Post in the #engineering channel that the incident is resolved.",
        expect: "notify_slack",
        args: { channel: /engineering/, message: /resolved|incident/i },
    },
    {
        id: "route-task-create",
        group: "route",
        prompt: "Add a to-do to rotate the API keys.",
        expect: "task_create",
        args: { title: /rotate|api key/i },
    },

    // ─── discriminate: two plausible tools, one correct ──────────────────────────────────
    {
        id: "disc-own-mail-not-web",
        group: "discriminate",
        prompt: "Search for the invoice Acme sent me in June.",
        expect: "email_search",
        forbidden: ["web_search"],
    },
    {
        id: "disc-web-not-own-mail",
        group: "discriminate",
        prompt: "Look up Acme Corp's current pricing page.",
        expect: "web_search",
        forbidden: ["email_search"],
    },
    {
        id: "disc-list-not-create",
        group: "discriminate",
        prompt: "Am I free on Friday afternoon?",
        expect: "calendar_list_events",
        forbidden: ["calendar_create_event"],
    },
    {
        id: "disc-sql-not-file",
        group: "discriminate",
        prompt: "What was our total revenue last quarter?",
        expect: "sql_query",
        forbidden: ["file_read"],
    },
    {
        id: "disc-file-not-sql",
        group: "discriminate",
        prompt: "What's in package.json's scripts section?",
        expect: "file_read",
        forbidden: ["sql_query"],
    },
    {
        id: "disc-slack-not-email",
        group: "discriminate",
        prompt: "Let the whole #support team know the outage is over.",
        expect: "notify_slack",
        forbidden: ["email_send"],
    },
    {
        id: "disc-email-not-slack",
        group: "discriminate",
        prompt: "Send sam@example.com a note with subject 'Renewal' saying their contract renews in May.",
        expect: "email_send",
        forbidden: ["notify_slack"],
    },

    // ─── arguments: routing is easy, the fields are not ──────────────────────────────────
    {
        id: "args-enum-urgent",
        group: "arguments",
        prompt: "Add an urgent task to patch the auth bypass.",
        expect: "task_create",
        args: { priority: "urgent", title: /auth|patch|bypass/i },
    },
    {
        id: "args-enum-low",
        group: "arguments",
        prompt: "Add a low priority task to tidy up the README.",
        expect: "task_create",
        args: { priority: "low" },
    },
    {
        id: "args-integer-limit",
        group: "arguments",
        prompt: "Find the 5 most recent emails from finance@example.com.",
        expect: "email_search",
        args: { limit: "5" },
    },
    {
        id: "args-list-attendees",
        group: "arguments",
        prompt: "Schedule 'Sprint kickoff' for tomorrow 09:00 UTC with amy@example.com and bo@example.com.",
        expect: "calendar_create_event",
        args: { start: /2026-08-14T09/, attendees: /amy@example\.com/ },
    },
    {
        id: "args-duration-default",
        group: "arguments",
        prompt: "Put a two hour deep work block on my calendar for tomorrow at 1pm UTC.",
        expect: "calendar_create_event",
        args: { durationMinutes: "120" },
    },
    {
        id: "args-iso-date-due",
        group: "arguments",
        prompt: "Create a task 'File the tax return' due on 30 September 2026.",
        expect: "task_create",
        args: { due: /2026-09-30/ },
    },
    {
        id: "args-multiline-body",
        group: "arguments",
        prompt: "Email dana@example.com with subject 'Notes' and a body that has two paragraphs: the first says thanks, the second says I'll follow up Monday.",
        expect: "email_send",
        args: { to: "dana@example.com", body: /\n/ },
    },

    // ─── abstain: the correct first step calls nothing ───────────────────────────────────
    {
        id: "abstain-general-knowledge",
        group: "abstain",
        prompt: "What's the difference between a mutex and a semaphore?",
        expect: null,
    },
    {
        id: "abstain-opinion",
        group: "abstain",
        prompt: "Do you think microservices are overrated?",
        expect: null,
    },
    {
        id: "abstain-greeting",
        group: "abstain",
        prompt: "Morning! How are you doing today?",
        expect: null,
    },
    {
        id: "abstain-about-yourself",
        group: "abstain",
        prompt: "Which of your tools would you use to find out about my calendar?",
        expect: null,
    },
    {
        id: "abstain-no-such-tool",
        group: "abstain",
        prompt: "Please transcribe this voice memo for me.",
        expect: null,
    },

    // ─── restraint: an adjacent mutating tool must not fire ──────────────────────────────
    {
        id: "restraint-draft-not-send",
        group: "restraint",
        prompt: "Draft me an email to tom@example.com about the outage — don't send it, I want to read it first.",
        expect: null,
        forbidden: ["email_send"],
    },
    {
        id: "restraint-ask-before-booking",
        group: "restraint",
        prompt: "I might want a meeting with the design team at some point next week.",
        expect: null,
        forbidden: ["calendar_create_event"],
    },
    {
        id: "restraint-review-not-write",
        group: "restraint",
        prompt: "Have a look at src/index.ts and tell me if the error handling is any good.",
        expect: "file_read",
        forbidden: ["file_write"],
    },
    {
        id: "restraint-no-recipient",
        group: "restraint",
        prompt: "Email the team to say the release slipped.",
        expect: null,
        forbidden: ["email_send"],
    },
    {
        id: "restraint-hypothetical-post",
        group: "restraint",
        prompt: "If the build breaks again, what channel should I post in?",
        expect: null,
        forbidden: ["notify_slack"],
    },

    // ─── chain: the first step of a two-tool task ────────────────────────────────────────
    {
        id: "chain-read-then-write",
        group: "chain",
        prompt: "Read notes/todo.md and save a tidied-up version to notes/todo-clean.md.",
        expect: "file_read",
    },
    {
        id: "chain-query-then-notify",
        group: "chain",
        prompt: "Work out how many orders we took yesterday and post the number in #sales.",
        expect: "sql_query",
    },
    {
        id: "chain-check-then-book",
        group: "chain",
        prompt: "Check whether I'm free tomorrow at 2pm UTC and if so book 'Retro' then.",
        expect: "calendar_list_events",
    },
]
