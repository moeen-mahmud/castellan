/**
 * `@dispach/server` — the wire protocol in `docs/04-SPEC-WIRE.md`.
 *
 * ```ts
 * const running = await serve({ runtime, host: "127.0.0.1", port: 7420, token })
 * ```
 *
 * `createHandler` is exported separately and is the more useful export for an embedder: it is a
 * plain `(Request) => Promise<Response>`, so it mounts inside any framework and is testable without
 * a socket.
 */

export { createHandler, type HandlerOptions } from "./handler.ts"
export { Router, type Route, type RouteMatch } from "./router.ts"
export { isLoopback, serve, type RunningServer, type ServeOptions } from "./serve.ts"
export {
    encodeFrame,
    HEARTBEAT_MS,
    sseResponse,
    type SseFrame,
    type SseStreamOptions,
} from "./sse.ts"
export { attachWebSocket, type WebSocketBridge, type WsSession } from "./ws.ts"
