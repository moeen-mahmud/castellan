/**
 * `$ref` resolution — `compactor: { $ref: model.selector }` reuses another role's definition
 * without repeating it.
 *
 * A dotted path from the manifest root, resolved before schema validation and before env
 * expansion, so the copy is of the *source text* rather than of a half-processed value.
 */

import { refCycle, refUnresolved } from "../errors.ts"

const REF_KEY = "$ref"

function isRefNode(value: unknown): value is Record<string, string> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false
    const keys = Object.keys(value)
    return (
        keys.length === 1 &&
        keys[0] === REF_KEY &&
        typeof (value as Record<string, unknown>)[REF_KEY] === "string"
    )
}

function lookup(root: unknown, ref: string): unknown {
    let node: unknown = root
    for (const segment of ref.split(".")) {
        if (node === null || typeof node !== "object") return undefined
        if (Array.isArray(node)) {
            const index = Number(segment)
            if (!Number.isInteger(index)) return undefined
            node = node[index]
            continue
        }
        node = (node as Record<string, unknown>)[segment]
    }
    return node
}

function structuredCopy(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(structuredCopy)
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value)) out[key] = structuredCopy(item)
        return out
    }
    return value
}

function resolveNode(node: unknown, root: unknown, path: string, chain: Set<string>): unknown {
    if (isRefNode(node)) {
        const ref = node[REF_KEY] ?? ""
        if (chain.has(ref)) throw refCycle(ref, path === "" ? "(root)" : path)

        const target = lookup(root, ref)
        if (target === undefined) throw refUnresolved(ref, path === "" ? "(root)" : path)

        // Resolve the target too — a $ref may point at something that itself contains one.
        return resolveNode(structuredCopy(target), root, path, new Set([...chain, ref]))
    }

    if (Array.isArray(node)) {
        return node.map((item, index) => resolveNode(item, root, `${path}[${index}]`, chain))
    }

    if (node !== null && typeof node === "object") {
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(node)) {
            out[key] = resolveNode(item, root, path === "" ? key : `${path}.${key}`, chain)
        }
        return out
    }

    return node
}

export function resolveRefs(root: unknown): unknown {
    return resolveNode(root, root, "", new Set())
}

/**
 * Shallow merge for `extends`: every top-level key the child declares replaces the base's
 * entirely. Arrays replace rather than concatenate — appending is the behaviour nobody can
 * predict from the file alone, and there is no syntax here for "remove one entry".
 */
export function shallowMerge(
    base: Record<string, unknown>,
    child: Record<string, unknown>,
): Record<string, unknown> {
    return { ...base, ...child }
}
