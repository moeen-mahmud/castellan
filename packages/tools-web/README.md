# @dispach/tools-web

Two read-only tools: `web_search` and `web_fetch`.

The fetching is a GET. The interesting part of this package is `address.ts` and `guard.ts`, which
decide what the agent is allowed to point a GET at.

```yaml
tools:
  providers:
    web:
      backend: tavily              # tavily | brave | exa
      apiKeyEnv: TAVILY_API_KEY    # the variable's name, never the key
      maxBytes: 2000000            # optional; stop reading a page here
  pinned:
    - web_search
    - web_fetch
```

`web_fetch` needs no key. `web_search` needs one, and says which variable is missing at the moment
it is called rather than at boot — an agent that pins only `web_fetch` should not fail to start on a
machine with no search key.

## The boundary

Every URL passes the same check, at every redirect hop:

1. **Scheme** — `http` and `https`. `file:`, `gopher:`, `data:` and the rest are refused by name.
2. **Credentials** — `https://user:pw@host` is refused rather than stripped. It is either a secret
   that should not be in a conversation, or an attempt to make the host look like something else.
3. **Hostname shape** — `localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, and any
   single-label name (`metadata`, `wiki`, `intranet`), all refused **before** any lookup happens.
4. **DNS** — one lookup, and **every** address it returns is classified. Node connects to whichever
   answers first, so checking `addresses[0]` checks an address the request may not use.
5. **Address** — loopback, link-local, RFC-1918, CGNAT, unspecified, multicast and the reserved
   ranges. `169.254.169.254` is inside link-local, so the cloud metadata endpoint is covered by a
   range rather than by a special case that could be edited away on its own.

IPv4-in-IPv6 is decoded first: `::ffff:127.0.0.1` and `64:ff9b::7f00:1` are loopback wearing a
different hat. Only one spelling of a dotted quad is accepted — `017.0.0.1` and `0x7f.0.0.1` are not
literals here, so they fall through to DNS and are classified on whatever comes back.

**There is no setting that permits a private address.** Not `allowPrivateHosts`, not a host
allowlist, not an "internal mode". The one real use of such a flag is reaching a service on the local
network, and the honest way to do that is `exec` with `curl` — a grant a person makes deliberately
and a policy rule can narrow.

### What this does not stop, said plainly

**DNS rebinding.** The lookup here and the connection the HTTP client makes are two separate
resolutions, and a name with a one-second TTL can answer differently for each. Closing that means
pinning the checked address into the socket, which `fetch` gives no way to do. So this is a strong
control against a URL that points somewhere internal, and a weak one against an attacker who controls
the nameserver for a domain the agent is asked to fetch.

**None of it binds `exec`.** A policy that allows the shell allows `curl`, and no amount of SSRF
checking here changes that. These controls bound *this tool*, not the agent.

## Both tools are untrusted

Declared, not defaulted. The registry would default a provider tool to `untrusted` anyway, but
declaring it keeps the `tool_trust_overridden` warning meaningful — a package that says nothing is
indistinguishable from a package that forgot — and it is the more honest statement besides. There is
no version of `web_fetch` whose output is trustworthy: the whole tool is "go and read what a stranger
wrote". Search results are content too; a page whose `<title>` is an instruction is a page anyone can
publish.

Their output reaches the model inside the untrusted delimiter, and a mutating call after one needs
authorisation the turn does not have by default. Measured against real models in `evals/web/` —
read the caveats there before quoting the numbers.

Nothing here tries to filter instruction-like phrasing out of fetched text. See decision 4.27: it
does not work, and an unreliable filter invites the belief that the problem is handled.

## Caps, and why each one says it was a cap

- **`maxBytes`** (2 MB) is enforced *while reading*, not after. `await response.text()` on a 50 MB
  page has already spent the 50 MB by the time anything can measure it, so the body is pulled chunk
  by chunk and the reader is cancelled at the cap.
- **6,000 characters** of extracted text reach the model, sized against `observationMaxTokens`. A
  tool whose output does not fit the budget is middle-cut and read again — `config_read` cost 8,040
  output tokens in one turn learning that.
- **5 redirects**, each re-checked. A chain longer than that is a tracker or a loop.

A page that hit either cap says so in the observation. A page silently cut at 6,000 characters is one
the model reasons about as though it had read all of it.

## Extraction

No DOM parser, and that is a decision rather than a shortcut. A parser's whole purpose is to be
correct about malformed markup written by strangers — which is exactly this input, and exactly the
reason not to run a large attack surface over it. Script, style and metadata elements are dropped
(including the *unterminated* forms, which is what a page cut at `maxBytes` leaves behind), block
elements become line breaks, tags go, entities decode. JSON passes through untouched.

The failure mode of the regex approach is a stray `<` in prose eating a few words. The failure mode
of the parser approach is a parser bug reachable from any page the agent fetches. The first is
visible in the observation; the second is not.

## Backends

One signature, three implementations, and the model must not be able to tell which is configured — a
catalogue that renders differently per backend makes `web_search` a different tool on different
machines. Everything backend-specific stops in `backends.ts`.

| | key variable | notes |
| --- | --- | --- |
| `tavily` | `TAVILY_API_KEY` | default. `include_answer` is deliberately off: a second model's summary of pages nobody checked, arriving as though it were a result. |
| `brave` | `BRAVE_API_KEY` | |
| `exa` | `EXA_API_KEY` | 400-character excerpts. Fetching the page is `web_fetch`'s job, where it is checked and capped. |
