/**
 * The runtime lease: who is allowed to serve an agent.
 *
 * Two levels. `claimLeases` is exercised directly against a real store with an injected liveness
 * probe, because the interesting cases are combinations of heartbeat age and pid state that no
 * amount of real waiting would produce reliably. Then two actual `Runtime`s over one database
 * file, because the bug this prevents is a *cross-process* one and a single-process test cannot
 * see it.
 *
 * On `./_harness.ts` so it runs under `node --test` too — the lease is contended through SQLite,
 * and the two drivers are exactly the thing that has diverged before.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { ChannelFactory } from "../src/runtime/channels.ts"
import {
    claimLeases,
    LEASE_REUSE_FACTOR,
    LEASE_STALE_MS,
    processAlive,
} from "../src/runtime/lease.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { openMemoryStore } from "../src/store/sqlite/store.ts"
import { describe, expect, test } from "./_harness.ts"

const NOW = Date.parse("2026-08-17T02:00:00.000Z")
const ENV = { MODEL_API_KEY: "test-key" }

const dead = () => false
const alive = () => true

describe("claiming a lease", () => {
    test("an unheld agent is claimed and reported as owned", async () => {
        const store = await openMemoryStore()
        const out = await claimLeases({
            store,
            agentIds: ["a", "b"],
            runtimeId: "rt_1",
            mode: "terminal",
            now: NOW,
            pid: 100,
            exclusive: true,
            isAlive: dead,
        })
        expect(out.owned).toEqual(["a", "b"])
        expect(out.tookOver).toEqual([])
        expect(out.declined).toEqual([])
        await store.close()
    })

    test("a live holder makes an exclusive runtime refuse, and the error names it", async () => {
        const store = await openMemoryStore()
        await claimLeases({
            store,
            agentIds: ["a"],
            runtimeId: "rt_1",
            mode: "daemon",
            now: NOW,
            pid: 4711,
            exclusive: true,
            isAlive: alive,
        })

        // A fresh heartbeat: live without needing the probe at all.
        await expect(
            claimLeases({
                store,
                agentIds: ["a"],
                runtimeId: "rt_2",
                mode: "terminal",
                now: NOW + 1000,
                pid: 4712,
                exclusive: true,
                isAlive: alive,
            }),
        ).rejects.toThrow("already being served by pid 4711")
        await store.close()
    })

    /**
     * The interactive case. Two `run` sessions against one agent have always been allowed, and
     * breaking that to fix a channel bug would be a regression in a flow people use daily — so a
     * non-exclusive runtime proceeds, owning nothing, and therefore recovering nothing.
     */
    test("a non-exclusive runtime proceeds without the lease and owns nothing", async () => {
        const store = await openMemoryStore()
        await claimLeases({
            store,
            agentIds: ["a"],
            runtimeId: "rt_1",
            mode: "terminal",
            now: NOW,
            pid: 100,
            exclusive: true,
            isAlive: alive,
        })

        const second = await claimLeases({
            store,
            agentIds: ["a"],
            runtimeId: "rt_2",
            mode: "terminal",
            now: NOW + 1000,
            pid: 200,
            exclusive: false,
            isAlive: alive,
        })
        expect(second.owned).toEqual([])
        expect(second.declined.map((lease) => lease.pid)).toEqual([100])
        // The holder is untouched — a declined claim must not quietly rewrite the row.
        expect((await store.leases.get("a"))?.runtimeId).toBe("rt_1")
        await store.close()
    })

    test("a stale heartbeat with a dead pid is taken over", async () => {
        const store = await openMemoryStore()
        await claimLeases({
            store,
            agentIds: ["a"],
            runtimeId: "rt_1",
            mode: "daemon",
            now: NOW,
            pid: 100,
            exclusive: true,
            isAlive: alive,
        })

        const out = await claimLeases({
            store,
            agentIds: ["a"],
            runtimeId: "rt_2",
            mode: "terminal",
            now: NOW + LEASE_STALE_MS + 1,
            pid: 200,
            exclusive: true,
            isAlive: dead,
        })
        expect(out.owned).toEqual(["a"])
        expect(out.tookOver.map((lease) => lease.pid)).toEqual([100])
        await store.close()
    })

    /**
     * The laptop-sleep case, and the one worth getting wrong-way-round: a wedged process still
     * holds its bot token. Taking the lease because its heartbeat lapsed is precisely how the
     * double-poller gets created, so a live pid beats a stale heartbeat.
     */
    test("a stale heartbeat with a live pid is still refused", async () => {
        const store = await openMemoryStore()
        await claimLeases({
            store,
            agentIds: ["a"],
            runtimeId: "rt_1",
            mode: "daemon",
            now: NOW,
            pid: 100,
            exclusive: true,
            isAlive: alive,
        })

        await expect(
            claimLeases({
                store,
                agentIds: ["a"],
                runtimeId: "rt_2",
                mode: "terminal",
                now: NOW + LEASE_STALE_MS + 1,
                pid: 200,
                exclusive: true,
                isAlive: alive,
            }),
        ).rejects.toThrow("already being served")
        await store.close()
    })

    /**
     * The bug this rule was rewritten for, found by installing the real thing.
     *
     * A boot that fails *after* claiming — `buildChannels` throwing on a missing bot token, which
     * is the single most likely install-time fault — leaves a lease whose heartbeat is seconds old
     * and whose process is already gone. Trusting the heartbeat first meant every retry for the
     * next ninety seconds was refused, naming a pid that no longer existed, at exactly the moment
     * somebody was fixing the fault. The pid decides when it says dead.
     */
    test("a dead pid is takeable immediately, however fresh the heartbeat", async () => {
        const store = await openMemoryStore()
        await claimLeases({
            store,
            agentIds: ["a"],
            runtimeId: "rt_1",
            mode: "daemon",
            now: NOW,
            pid: 100,
            exclusive: true,
            isAlive: alive,
        })

        const out = await claimLeases({
            store,
            agentIds: ["a"],
            runtimeId: "rt_2",
            mode: "terminal",
            now: NOW + 1000,
            pid: 200,
            exclusive: true,
            isAlive: dead,
        })
        expect(out.owned).toEqual(["a"])
        expect(out.tookOver.map((lease) => lease.pid)).toEqual([100])
        await store.close()
    })

    /**
     * The other half. A pid still resolving after forty-five minutes without a heartbeat is far
     * more likely to be an unrelated program that inherited the number than the original holder,
     * and refusing forever on that evidence leaves a lease recoverable only by editing the
     * database.
     */
    test("a live pid with an ancient heartbeat is assumed recycled", async () => {
        const store = await openMemoryStore()
        await claimLeases({
            store,
            agentIds: ["a"],
            runtimeId: "rt_1",
            mode: "daemon",
            now: NOW,
            pid: 100,
            exclusive: true,
            isAlive: alive,
        })

        const out = await claimLeases({
            store,
            agentIds: ["a"],
            runtimeId: "rt_2",
            mode: "terminal",
            now: NOW + LEASE_STALE_MS * LEASE_REUSE_FACTOR + 1,
            pid: 200,
            exclusive: true,
            isAlive: alive,
        })
        expect(out.owned).toEqual(["a"])
        await store.close()
    })

    test("processAlive answers for this process and not for an impossible pid", () => {
        expect(processAlive(process.pid)).toBe(true)
        expect(processAlive(0)).toBe(false)
        expect(processAlive(-1)).toBe(false)
    })
})

function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "lease-test-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: test-model
    baseUrl: https://example.invalid/v1
    apiKeyEnv: MODEL_API_KEY
`,
        "utf8",
    )
    return dir
}

describe("two runtimes over one database", () => {
    test("the second refuses to serve, and the first keeps its lease", async () => {
        const dir = workspace()
        const dbPath = join(dir, "store.db")
        try {
            const first = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                store: dbPath,
                // What `serve` passes. Without it a second runtime is allowed, which is right for
                // a REPL and wrong for anything holding a channel open.
                startChannels: true,
                mode: "daemon",
            })
            expect(first.owned).toEqual(["test"])

            await expect(
                Runtime.create({
                    agents: [join(dir, "agent.yaml")],
                    env: ENV,
                    store: dbPath,
                    startChannels: true,
                }),
            ).rejects.toThrow("already being served")

            // Still the first one's, and still reported as a service rather than a bare number.
            const held = await first.store.leases.get("test")
            expect(held?.runtimeId).toBe(first.runtimeId)
            expect(held?.mode).toBe("daemon")

            await first.stop()
            // Released on the way out, so the next start is not gated on a stale-heartbeat wait.
            const store = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                store: dbPath,
                startChannels: true,
            })
            expect(store.owned).toEqual(["test"])
            await store.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("a REPL alongside a serving runtime is allowed and reaps nothing", async () => {
        const dir = workspace()
        const dbPath = join(dir, "store.db")
        try {
            const serving = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                store: dbPath,
                startChannels: true,
                mode: "daemon",
            })
            await serving.store.turns.start({
                turnId: "t_live",
                agentId: "test",
                sessionKey: "local:default",
                source: "channel",
                input: "x",
            })

            // A `run` in another terminal. Before the lease this boot marked `t_live` failed —
            // silently, with the row claiming the process had exited, while it was mid-generation.
            const repl = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                store: dbPath,
                mode: "terminal",
            })
            expect(repl.owned).toEqual([])
            expect((await repl.store.turns.get("t_live"))?.status).toBe("running")

            await repl.stop()
            await serving.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

/**
 * Slot 2's honesty about channels, asserted at the runtime layer where it is actually decided.
 *
 * Decision 5.17 made the configuration block report *state*, and the wiring got it wrong in a way
 * the block's own unit tests could not see: they pass `channelsStarted` in, while the runtime
 * derived it from `hub.statusOf(id).length > 0` — true of `run` as well, because a binding is
 * registered either way. So an agent under `run` was told its channel was connected in this
 * session, which is the exact sentence 5.17 exists to prevent, one layer down from the fix.
 */
describe("channels are started, not merely configured", () => {
    const stub: ChannelFactory = (context) => ({
        id: context.id,
        type: "stub",
        limits: { maxMessageChars: 4096, idempotentSend: false },
        start: async () => {},
        stop: async () => {},
        send: async () => ({ ok: true as const, providerMessageId: "1" }),
    })

    function withChannel(): string {
        const dir = mkdtempSync(join(tmpdir(), "lease-chan-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: test-model
    baseUrl: https://example.invalid/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: stub
    id: sc
`,
            "utf8",
        )
        return dir
    }

    test("a REPL registers the channel and does not start it", async () => {
        const dir = withChannel()
        try {
            const runtime = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                channels: { stub },
            })
            // Registered — which is precisely why counting registrations was the wrong signal.
            expect(runtime.channels.statusOf("test").length).toBe(1)
            expect(runtime.channels.started).toBe(false)
            await runtime.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("serve starts them", async () => {
        const dir = withChannel()
        try {
            const runtime = await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                channels: { stub },
                startChannels: true,
            })
            expect(runtime.channels.started).toBe(true)
            await runtime.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
