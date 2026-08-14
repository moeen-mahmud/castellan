/**
 * A shallow read of a manifest's identity — for listings, never for loading.
 *
 * `loadManifest` is deliberately unusable here: it expands env references and checks that the
 * named key variables are set, so a *picker* built on it would fail exactly when it is needed
 * most — on a machine where the key is not exported yet. Listing an agent must never require its
 * credentials. This reads only `id`, `name`, and `model.main.id`, with no env expansion, no
 * schema validation, no `extends` resolution, and returns raw strings: `${MODEL_ID}` comes back
 * verbatim, and the caller decides how to display it.
 *
 * Lives in core because core owns the YAML dependency — the CLI's runtime dependencies are
 * capped at the renderer pair by decision 11.10.
 */

import { readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import { manifestNotYaml, manifestUnreadable } from "../errors.ts"

export interface ManifestHeader {
    readonly id?: string
    readonly name?: string
    /** Raw — may literally be an unexpanded `${MODEL_ID}` reference. */
    readonly modelId?: string
}

export function readManifestHeader(
    path: string,
    readFile: (path: string) => string = (target) => readFileSync(target, "utf8"),
): ManifestHeader {
    let text: string
    try {
        text = readFile(path)
    } catch (cause) {
        throw manifestUnreadable(path, cause)
    }

    let parsed: unknown
    try {
        parsed = parseYaml(text)
    } catch (cause) {
        throw manifestNotYaml(path, cause)
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        // The same shape failure loadManifest reports, reused so a broken file reads the same
        // in a listing's `problem` column as it would at load.
        throw manifestNotYaml(path, new Error("did not parse to a mapping"))
    }

    const record = parsed as Record<string, unknown>
    const model = record.model
    const main =
        model !== null && typeof model === "object" && !Array.isArray(model)
            ? (model as Record<string, unknown>).main
            : undefined
    const mainId =
        main !== null && typeof main === "object" && !Array.isArray(main)
            ? (main as Record<string, unknown>).id
            : undefined

    return {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof mainId === "string" ? { modelId: mainId } : {}),
    }
}
