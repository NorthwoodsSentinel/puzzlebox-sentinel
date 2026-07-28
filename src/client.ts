// puzzlebox-sentinel — minimal puzzlebox (MCP) client
// Two transports, no SDK dependency:
//   - SSE:            GET /sse for the event stream, POST JSON-RPC to the
//                     announced /message endpoint, responses arrive on the stream
//   - streamableHttp: POST JSON-RPC to a single endpoint, response inline
//                     (JSON or a one-shot SSE body), session id via header
// Both expose the same surface: callTool + subscribe + close. Snapshot polling
// via get_puzzle_snapshot works on either; resource subscription is best-effort
// (fail-open: if subscribe is refused or errors, the sentinel polls anyway).

import type { PuzzleSnapshot } from "./types.ts";

const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "puzzlebox-sentinel", version: "0.1.0" };

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string; // present on notifications
  params?: unknown;
}

export interface PuzzleboxClient {
  initialize(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  // Returns true if the subscription was accepted. onUpdated fires when a
  // notifications/resources/updated arrives for the given URI.
  subscribe(uri: string, onUpdated: () => void): Promise<boolean>;
  close(): void;
}

export function puzzleResourceUri(puzzleId: string): string {
  return `puzzlebox:/puzzle/${puzzleId}`;
}

// ── Shared helpers ────────────────────────────────────────────

function parseToolResult(result: unknown): unknown {
  // MCP tool results carry content blocks: { content: [{ type: "text", text }] }.
  // Puzzlebox puts JSON in the text block. Fall through to the raw result if
  // the shape is anything else.
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

export function asSnapshot(value: unknown): PuzzleSnapshot {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    currentState: typeof v.currentState === "string" ? v.currentState : undefined,
    availableActions: Array.isArray(v.availableActions)
      ? v.availableActions.filter((a): a is string => typeof a === "string")
      : undefined,
  };
}

// ── SSE transport ─────────────────────────────────────────────
// Matches puzzlebox's src/sse.ts: GET {base}/sse announces a /message?sessionId=
// endpoint in an `endpoint` event; JSON-RPC requests are POSTed there and the
// responses come back over the SSE stream as `message` events.

export class SseClient implements PuzzleboxClient {
  private messageUrl: string | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private subscriptions = new Map<string, () => void>();
  private abort = new AbortController();
  private endpointReady: Promise<void>;
  private endpointResolve!: () => void;
  private endpointReject!: (e: Error) => void;

  constructor(private readonly baseUrl: string) {
    this.endpointReady = new Promise((resolve, reject) => {
      this.endpointResolve = resolve;
      this.endpointReject = reject;
    });
  }

  async initialize(): Promise<void> {
    this.startStream();
    await this.withTimeout(this.endpointReady, 10_000, "SSE endpoint announcement");
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    await this.notify("notifications/initialized", {});
  }

  private startStream(): void {
    const url = new URL("/sse", this.baseUrl).toString();
    fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: this.abort.signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          this.endpointReject(new Error(`SSE connect failed: HTTP ${res.status}`));
          return;
        }
        await this.readStream(res.body);
      })
      .catch((e) => {
        this.endpointReject(e instanceof Error ? e : new Error(String(e)));
      });
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        this.handleFrame(frame);
      }
    }
  }

  private handleFrame(frame: string): void {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join("\n");
    if (event === "endpoint") {
      this.messageUrl = new URL(data, this.baseUrl).toString();
      this.endpointResolve();
      return;
    }
    if (!data) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // not JSON-RPC; ignore
    }
    this.dispatch(msg);
  }

  private dispatch(msg: JsonRpcResponse): void {
    if (msg.method === "notifications/resources/updated") {
      const uri = (msg.params as { uri?: string } | undefined)?.uri;
      if (uri) this.subscriptions.get(uri)?.();
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`JSON-RPC ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }

  private async post(payload: unknown): Promise<void> {
    if (!this.messageUrl) throw new Error("SSE transport not initialized");
    const res = await fetch(this.messageUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: this.abort.signal,
    });
    if (!res.ok && res.status !== 202) {
      throw new Error(`POST /message failed: HTTP ${res.status}`);
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.post({ jsonrpc: "2.0", id, method, params });
    return this.withTimeout(result, 15_000, method);
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request("tools/call", { name, arguments: args });
    return parseToolResult(result);
  }

  async subscribe(uri: string, onUpdated: () => void): Promise<boolean> {
    try {
      this.subscriptions.set(uri, onUpdated);
      await this.request("resources/subscribe", { uri });
      return true;
    } catch {
      this.subscriptions.delete(uri);
      return false;
    }
  }

  close(): void {
    this.abort.abort();
    for (const [, p] of this.pending) p.reject(new Error("client closed"));
    this.pending.clear();
  }
}

// ── streamableHttp transport ──────────────────────────────────
// Single endpoint, request/response in one round trip. Session id travels in
// the mcp-session-id header after initialize. Server-initiated notifications
// are NOT received on this transport in v0 (no standing GET stream), so
// subscribe() reports false and the sentinel relies on polling.

export class StreamableHttpClient implements PuzzleboxClient {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(private readonly endpointUrl: string) {}

  async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    void result;
    await this.rawPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  private async rawPost(payload: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    return res;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.rawPost({ jsonrpc: "2.0", id, method, params });
    if (!res.ok) throw new Error(`${method} failed: HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    let msg: JsonRpcResponse | undefined;
    if (contentType.includes("text/event-stream")) {
      // One-shot SSE body: find the message frame answering our id.
      const text = await res.text();
      for (const frame of text.split("\n\n")) {
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as JsonRpcResponse;
          if (parsed.id === id) {
            msg = parsed;
            break;
          }
        } catch {
          // skip non-JSON frames
        }
      }
    } else {
      msg = (await res.json()) as JsonRpcResponse;
    }
    if (!msg) throw new Error(`${method}: no response frame for id ${id}`);
    if (msg.error) throw new Error(`JSON-RPC ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request("tools/call", { name, arguments: args });
    return parseToolResult(result);
  }

  async subscribe(_uri: string, _onUpdated: () => void): Promise<boolean> {
    return false; // no server-push channel on this transport in v0 — poll instead
  }

  close(): void {
    // stateless; nothing held open
  }
}

// ── Connection ladder ─────────────────────────────────────────
// auto: try SSE first (puzzlebox's shipped transport), fall back to
// streamableHttp. Explicit transport pins one rung.

export type TransportChoice = "sse" | "http" | "auto";

export async function connect(
  serverUrl: string,
  transport: TransportChoice,
  log: (line: string) => void = () => {},
): Promise<PuzzleboxClient> {
  if (transport === "sse" || transport === "auto") {
    const sse = new SseClient(serverUrl);
    try {
      await sse.initialize();
      log(`connected via SSE: ${serverUrl}`);
      return sse;
    } catch (e) {
      sse.close();
      if (transport === "sse") throw e;
      log(`SSE connect failed (${e instanceof Error ? e.message : e}); trying streamableHttp`);
    }
  }
  const endpoint = new URL("/mcp", serverUrl).toString();
  const http = new StreamableHttpClient(endpoint);
  await http.initialize();
  log(`connected via streamableHttp: ${endpoint}`);
  return http;
}
