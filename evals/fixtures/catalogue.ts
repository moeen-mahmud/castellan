/**
 * The eval catalogue: ten tools, shared by both dialects.
 *
 * Sized and shaped to make the measurement mean something. Two tools is not a routing problem — a
 * model gets it right by coin flip. Ten tools with deliberate near-neighbours (`email_search` beside
 * `web_search`, `calendar_list_events` beside `calendar_create_event`, `file_read` beside `sql_query`)
 * is one, and it is the shape a real agent has.
 *
 * Every spec carries a real `whenToUse` and `whenNotToUse`, because both dialects render them and the
 * comparison is only fair if both get the same guidance. Six of the ten are mutating, so the
 * "critical error" rate — a side-effecting tool fired when it should not have been — has room to
 * show up rather than being a rounding error.
 *
 * Handlers return canned observations and touch nothing. Scoring stops at the first step: what was
 * routed to, and whether the arguments were right. Nothing here is ever executed by the harness, so
 * the handlers exist only to satisfy `Tool` — see the note in `scripts/eval-tools.ts`.
 */

import type { Tool, ToolProvider, ToolSpec } from "../../packages/core/src/tools/types.ts"

const SPECS: readonly ToolSpec[] = [
    {
        slug: "email_send",
        provider: "eval",
        summary: "Sends an email from the owner's mailbox.",
        whenToUse: "the person asks you to email, reply to, or forward something to someone",
        whenNotToUse:
            "they asked for a draft, asked you to check or find mail, or have not named a recipient",
        mutating: true,
        tags: ["write", "email"],
        parameters: {
            type: "object",
            properties: {
                to: { type: "string", description: "one recipient email address" },
                subject: { type: "string" },
                body: { type: "string", description: "plain text" },
            },
            required: ["to", "subject", "body"],
        },
    },
    {
        slug: "email_search",
        provider: "eval",
        summary: "Searches the owner's own mailbox and returns matching messages.",
        whenToUse: "the person asks about mail they have received or sent",
        whenNotToUse:
            "they are asking about something on the public web — that is web_search — or asking you to send anything",
        mutating: false,
        tags: ["read", "email"],
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "words to match, or a sender's name" },
                limit: { type: "integer", default: 20 },
            },
            required: ["query"],
        },
    },
    {
        slug: "calendar_create_event",
        provider: "eval",
        summary: "Puts a new event on the owner's calendar.",
        whenToUse: "the person asks you to book, schedule, or add something to the calendar",
        whenNotToUse:
            "they are asking what is already scheduled — that is calendar_list_events — or have given no time",
        mutating: true,
        tags: ["write", "calendar"],
        parameters: {
            type: "object",
            properties: {
                title: { type: "string" },
                start: { type: "string", description: "ISO 8601, e.g. 2026-08-14T15:00:00Z" },
                durationMinutes: { type: "integer", default: 30 },
                attendees: { type: "array", items: { type: "string" } },
            },
            required: ["title", "start"],
        },
    },
    {
        slug: "calendar_list_events",
        provider: "eval",
        summary: "Lists events already on the owner's calendar for a given day.",
        whenToUse: "the person asks what is scheduled, or whether they are free",
        whenNotToUse: "they are asking you to add, move, or cancel anything",
        mutating: false,
        tags: ["read", "calendar"],
        parameters: {
            type: "object",
            properties: { date: { type: "string", description: "ISO date, e.g. 2026-08-14" } },
            required: ["date"],
        },
    },
    {
        slug: "file_read",
        provider: "eval",
        summary: "Reads a file from the project working directory.",
        whenToUse: "the person names a file and wants its contents or something inside it",
        whenNotToUse:
            "the data lives in the database — that is sql_query — or they want the file changed",
        mutating: false,
        tags: ["read", "file"],
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "relative path" } },
            required: ["path"],
        },
    },
    {
        slug: "file_write",
        provider: "eval",
        summary: "Writes a file in the project working directory, replacing it if it exists.",
        whenToUse: "the person asks you to save, create, or overwrite a file",
        whenNotToUse:
            "they only asked to see or review something, or have not said what should be in it",
        mutating: true,
        tags: ["write", "file"],
        parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
        },
    },
    {
        slug: "web_search",
        provider: "eval",
        summary: "Searches the public web and returns result snippets.",
        whenToUse:
            "the person asks about something public, current, or outside their own data — news, documentation, a company",
        whenNotToUse:
            "they are asking about their own mail, files, calendar or database, or about something you already know",
        mutating: false,
        tags: ["read", "search"],
        parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
        },
    },
    {
        slug: "sql_query",
        provider: "eval",
        summary: "Runs a read-only SQL query against the application database.",
        whenToUse:
            "the person asks a question about application data — customers, orders, revenue, counts",
        whenNotToUse:
            "the answer is in a file or on the web, or they want data changed rather than read",
        mutating: false,
        tags: ["read", "database"],
        parameters: {
            type: "object",
            properties: { sql: { type: "string", description: "a single SELECT statement" } },
            required: ["sql"],
        },
    },
    {
        slug: "notify_slack",
        provider: "eval",
        summary: "Posts a message to a Slack channel the owner belongs to.",
        whenToUse: "the person asks you to tell, notify, or post something to a team or channel",
        whenNotToUse:
            "the message is meant for one person by email — that is email_send — or they have named no channel",
        mutating: true,
        tags: ["write", "chat"],
        parameters: {
            type: "object",
            properties: {
                channel: { type: "string", description: "channel name without the leading #" },
                message: { type: "string" },
            },
            required: ["channel", "message"],
        },
    },
    {
        slug: "task_create",
        provider: "eval",
        summary: "Creates a task in the owner's tracker.",
        whenToUse: "the person asks you to add a to-do, ticket, task, or reminder",
        whenNotToUse:
            "they are asking what is already on their list, or asking you to do the thing",
        mutating: true,
        tags: ["write", "tasks"],
        parameters: {
            type: "object",
            properties: {
                title: { type: "string" },
                priority: {
                    type: "string",
                    enum: ["low", "normal", "high", "urgent"],
                    default: "normal",
                },
                due: { type: "string", description: "ISO date" },
            },
            required: ["title"],
        },
    },
]

export const EVAL_TOOL_SLUGS: readonly string[] = SPECS.map((spec) => spec.slug)

/** Slugs whose invocation has a side effect. A wrong call here is a *critical* error, not a miss. */
export const MUTATING_SLUGS: readonly string[] = SPECS.filter((spec) => spec.mutating).map(
    (spec) => spec.slug,
)

/**
 * A provider over the fixture catalogue.
 *
 * The handlers throw rather than returning a canned string. Nothing in the eval executes a tool —
 * scoring is `planIntents`, which resolves and coerces without running anything — so a handler that
 * *ran* would mean the harness was doing something it does not intend to. Better a loud failure than
 * a plausible number produced by a path nobody meant to take.
 */
export function evalToolProvider(): ToolProvider {
    const tools: readonly Tool[] = SPECS.map((spec) => ({
        spec,
        handler: () => {
            throw new Error(
                `${spec.slug} was executed. The eval scores routing and arguments only, so no handler should ever run — this is a bug in scripts/eval-tools.ts.`,
            )
        },
    }))

    return {
        id: "eval",
        resolve: async (slugs) => tools.filter((tool) => slugs.includes(tool.spec.slug)),
        list: async () => EVAL_TOOL_SLUGS,
    }
}
