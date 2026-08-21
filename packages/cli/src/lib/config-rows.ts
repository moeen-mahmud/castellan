/**
 * What the config editor shows, and what one confirmed row does. Reads files; no Ink.
 *
 * Its own module because **both hosts import it statically** — `config.ts` for the standalone editor and
 * `App.tsx` for the pane — while `index.ts` imports `config.ts` *dynamically* to keep Ink off the
 * startup path. A module reached both ways makes `bun build --splitting` emit its exports twice and the
 * binary refuses to parse, and `bun test` sails straight through it because tests import source. So the
 * shared half lives where nothing has to be lazy about it.
 */

import { readFileSync } from "node:fs"
import { HarnessError, manifestDocument, manifestValueAt, SETTINGS } from "@dispach/core"
import { applyAllow, applySecret, applySet } from "#lib/config-apply"
import type { EditorRow } from "#lib/config-editor"
import { agentEnv, isSet } from "#lib/config-env"
import { editorRows, envNeeds, type SettingValue } from "#lib/config-view"

/**
 * Every setting with whatever the file currently holds.
 *
 * Two rows do not have a readable dotted path — `allowFrom` lives inside a list entry and `writeRoots`
 * inside a provider — so they are gathered by walking the block instead. Shown rather than omitted: a
 * field missing from a listing reads as "no such concept", which is the same reasoning that puts a
 * `none` row in slot 2 instead of leaving the line out.
 */
export function currentValues(manifestPath: string): readonly SettingValue[] {
    const source = readFileSync(manifestPath, "utf8")
    return SETTINGS.map((setting) => {
        if (setting.path === "channels[].allowFrom") {
            const channels = manifestValueAt(source, ["channels"])
            if (!Array.isArray(channels)) return { setting, value: undefined }
            const byId: Record<string, unknown> = {}
            for (const entry of channels) {
                if (typeof entry !== "object" || entry === null) continue
                const row = entry as { id?: unknown; allowFrom?: unknown }
                if (typeof row.id !== "string") continue
                byId[row.id] = row.allowFrom ?? []
            }
            return { setting, value: Object.keys(byId).length === 0 ? undefined : byId }
        }
        if (setting.path === "tools.providers.<id>.writeRoots") {
            const providers = manifestValueAt(source, ["tools", "providers"])
            if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
                return { setting, value: undefined }
            }
            const roots: Record<string, unknown> = {}
            for (const [id, config] of Object.entries(providers as Record<string, unknown>)) {
                if (typeof config !== "object" || config === null) continue
                const found = (config as { writeRoots?: unknown }).writeRoots
                if (found !== undefined) roots[id] = found
            }
            return { setting, value: Object.keys(roots).length === 0 ? undefined : roots }
        }
        return { setting, value: manifestValueAt(source, setting.path.split(".")) }
    })
}

/**
 * The rows the editor shows, read fresh from the manifest and its `.env`.
 *
 * Exported because both hosts build them: this command mounts the editor standalone, and the chat opens
 * it as a pane. Two builders would drift on the first row either one grew.
 */
export function editorRowsFor(manifestPath: string): readonly EditorRow[] {
    const source = readFileSync(manifestPath, "utf8")
    const document = manifestDocument(source)
    const env = agentEnv(manifestPath)
    const channels = manifestValueAt(source, ["channels"])

    return editorRows(currentValues(manifestPath), {
        channels: (Array.isArray(channels) ? channels : [])
            .filter(
                (entry): entry is Record<string, unknown> =>
                    typeof entry === "object" && entry !== null && !Array.isArray(entry),
            )
            .map((entry) => ({
                id: String(entry.id ?? ""),
                type: String(entry.type ?? ""),
                allowFrom: Array.isArray(entry.allowFrom) ? entry.allowFrom.map(String) : [],
            }))
            .filter((entry) => entry.id !== ""),
        secrets: envNeeds(document),
        // The agent's layered environment, not this process's — `ambientEnv` alone never adds the file
        // beside the manifest, which made a row read `(not set)` right after somebody set it.
        present: (name: string) => isSet(env, name),
    })
}

/**
 * Perform one row's edit. The editor's only asynchronous part, and the plain commands' path too.
 *
 * A blank buffer means different things per row and each is the useful reading: no handles is "allow
 * nobody", which is a real thing to want; an empty *setting* would be a value nobody typed on purpose;
 * and an empty secret is refused by `applySecret`, because a variable set to nothing fails the load
 * exactly as a missing one does.
 */
export async function applyEditorRow(
    manifestPath: string,
    row: EditorRow,
    raw: string,
): Promise<string> {
    switch (row.kind) {
        case "setting": {
            if (raw.trim() === "") {
                throw new HarnessError({
                    code: "cli_config_value_missing",
                    message: `No value given for ${row.setting.path}.`,
                    hint: 'A bare word, a number, a list as ["a", "b"], or a map as {k: v}.',
                    field: "value",
                })
            }
            return (await applySet(manifestPath, row.setting.path, raw)).note
        }
        case "allow": {
            const handles = raw.trim() === "" ? [] : raw.trim().split(/\s+/)
            return (await applyAllow(manifestPath, row.channelId, handles)).note
        }
        case "secret":
            return applySecret(manifestPath, row.name, raw).note
        case "heading":
            return ""
    }
}
