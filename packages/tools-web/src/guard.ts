/**
 * The check every outbound URL passes, at every hop.
 *
 * ## The order matters
 *
 * Scheme, then credentials, then the hostname's own shape, then DNS, then every address DNS
 * returned. Each step is cheaper than the next and refuses a different class of thing, so the
 * expensive one runs only on input that survived the free ones — and, more importantly, a
 * `file:///etc/passwd` never reaches a resolver that might do something interesting with it.
 *
 * ## Every address, not the first
 *
 * A name resolving to one public and one private address is an attack, not a configuration. Node's
 * HTTP client picks whichever address connects first, so checking `addresses[0]` checks an address
 * the request may not use. All of them, or none.
 *
 * ## What this does not stop, said plainly
 *
 * **DNS rebinding.** The lookup here and the connection the HTTP client makes are two separate
 * resolutions, and a name with a one-second TTL can answer differently for each. Closing that means
 * pinning the checked address into the socket, which `fetch` gives no way to do — the honest fix is a
 * custom agent/dispatcher, and it is not in this phase. So this is a strong control against a URL
 * that points somewhere internal and a weak one against an attacker who controls the nameserver for
 * a domain the agent is asked to fetch.
 *
 * Recording the gap rather than implying it is covered: a checker described as airtight is one nobody
 * revisits.
 */

import { lookup } from "node:dns/promises"
import { classifyAddress } from "./address.ts"
import {
    webAddressRefused,
    webCredentialsRefused,
    webHostRefused,
    webHostUnresolvable,
    webSchemeRefused,
    webUrlUnparseable,
} from "./errors.ts"

/** Resolve a hostname to every address it has. Injected so the guard is testable without DNS. */
export type LookupLike = (hostname: string) => Promise<readonly { address: string }[]>

const ALLOWED_SCHEMES = new Set(["http:", "https:"])

/**
 * Suffixes that never name a public host.
 *
 * `.local` is mDNS, `.internal` is the conventional private zone (and GCP's real one), `.localhost`
 * is reserved to loopback by RFC 6761, and the rest are reserved names that only ever resolve
 * somewhere a resolver made up. Refused before DNS because a search domain can make any of them
 * resolve to something real on an intranet.
 */
const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".intranet", ".lan", ".home.arpa"]

export function parseUrl(raw: string): URL {
    const trimmed = raw.trim()
    if (trimmed === "") throw webUrlUnparseable(raw, "the value is empty")
    try {
        return new URL(trimmed)
    } catch (cause) {
        throw webUrlUnparseable(raw, cause instanceof Error ? cause.message : String(cause))
    }
}

/**
 * Everything that can be decided without a network round trip.
 *
 * Separate from the DNS half so a caller can reject a URL before spending a lookup on it, and so the
 * expensive half has one job.
 */
export function checkUrlShape(url: URL): void {
    if (!ALLOWED_SCHEMES.has(url.protocol)) throw webSchemeRefused(url.protocol.replace(":", ""))
    if (url.username !== "" || url.password !== "") throw webCredentialsRefused()

    const host = url.hostname.toLowerCase()
    if (host === "") throw webHostRefused(url.href, "there is no host in the URL")
    if (host === "localhost") throw webHostRefused(host, "it is this machine by definition")

    for (const suffix of PRIVATE_SUFFIXES) {
        if (host.endsWith(suffix)) {
            throw webHostRefused(
                host,
                `${suffix} names are resolved on the local network, not the internet`,
            )
        }
    }

    // A single label — `intranet`, `wiki`, `metadata` — is completed by the resolver's search domain
    // into whatever the local network calls it. There is no such thing as a public single-label host,
    // and `metadata` in particular resolves to the cloud metadata endpoint on GCP.
    const bare = host.startsWith("[") ? "" : host
    if (bare !== "" && !bare.includes(".") && classifyAddress(host) === undefined) {
        throw webHostRefused(
            host,
            "a name with no dot in it is completed by the local search domain",
        )
    }
}

/**
 * The full check: shape, then the address behind the name.
 *
 * `hop` is only for the message — hop 0 is what the model asked for, and anything above it was
 * reached by a redirect the model never saw. The two are worth telling apart when reading a refusal.
 */
export async function assertFetchable(url: URL, lookupFn: LookupLike, hop = 0): Promise<void> {
    checkUrlShape(url)

    const host = url.hostname.toLowerCase()

    // An address literal needs no resolver, and must not get one: `new URL("http://127.0.0.1")` has a
    // hostname a lookup would happily hand straight back, and routing it through DNS would make the
    // most direct attack the one path with an extra moving part in it.
    const literal = classifyAddress(host)
    if (literal !== undefined) {
        if (literal.kind !== "public") {
            throw webAddressRefused(host, host, literal.kind, literal.range, hop)
        }
        return
    }

    let addresses: readonly { address: string }[]
    try {
        addresses = await lookupFn(host)
    } catch (cause) {
        throw webHostUnresolvable(host, cause instanceof Error ? cause.message : String(cause))
    }
    if (addresses.length === 0) throw webHostUnresolvable(host, "it has no addresses")

    for (const { address } of addresses) {
        const verdict = classifyAddress(address)
        // An address DNS returned that this cannot parse is refused, not waved through. Fail closed:
        // the unparseable case is either a resolver returning something strange or a gap in the
        // parser, and neither is a reason to make the request anyway.
        if (verdict === undefined) {
            throw webAddressRefused(
                host,
                address,
                "an address this cannot classify",
                undefined,
                hop,
            )
        }
        if (verdict.kind !== "public") {
            throw webAddressRefused(host, address, verdict.kind, verdict.range, hop)
        }
    }
}

/** The real resolver, used when nothing injects one. */
export const systemLookup: LookupLike = async (hostname) => {
    const results = await lookup(hostname, { all: true, verbatim: true })
    return results.map((entry) => ({ address: entry.address }))
}
