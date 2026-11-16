// Client transports against real loopback HTTP: the mock puzzlebox for the happy paths, and small purpose-built
// servers for every refusal and malformed-input path. No production code is stubbed except where a branch needs
// a non-Error rejection that no real server can produce.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  asSnapshot,
  connect,
  puzzleResourceUri,
  SseClient,
  StreamableHttpClient,
  type PuzzleboxClient,
} from "../src/client.ts";
import { readBody, sseFrame, startHttpServer, type Handler, type TestServer } from "./helpers/http-server.ts";
import { startMockPuzzlebox, type MockPuzzlebox } from "./mock-puzzlebox.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function server(handler: Handler): Promise<TestServer> {
  const s = await startHttpServer(handler);
  cleanups.push(() => s.close());
  return s;
}

async function mock(): Promise<MockPuzzlebox> {
  const m = await startMockPuzzlebox("PLAYING", ["END_GAME"]);
  cleanups.push(() => m.stop());
  return m;
}

function track<T extends PuzzleboxClient>(client: T): T {
  cleanups.push(() => client.close());
  return client;
}

// A scripted SSE server: GET /sse announces /message, then `onRequest` decides what goes back on the stream for
// each POSTed JSON-RPC message, and `postStatus` what the POST itself returns.
async function scriptedSse(opts: {
  onRequest: (msg: { id?: number; method?: string }, write: (chunk: string) => void) => void;
  postStatus?: number;
  endAfterAnnounce?: boolean;
}): Promise<TestServer> {
  let stream: ((chunk: string) => void) | null = null;
  return server(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sseFrame("/message?sessionId=x", "endpoint"));
      if (opts.endAfterAnnounce) {
        res.end();
        return;
      }
      stream = (chunk) => res.write(chunk);
      return;
    }
    const msg = JSON.parse(await readBody(req)) as { id?: number; method?: string };
    res.writeHead(opts.postStatus ?? 202);
    res.end();
    if (stream) opts.onRequest(msg, stream);
  });
}

// SseClient.request() creates its response promise, awaits the POST, and only then attaches a handler (inside
// withTimeout). A server that answers with an error on the stream before the POST settles therefore produces a
// rejection with no handler yet: an unhandled rejection in the code as it stands (noted in the PR). Tests that
// send an error answer wait for this signal, an awaited condition, so they exercise the handled path only.
function armed(label: string): Promise<void> {
  return new Promise((resolve) => {
    const proto = SseClient.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const original = proto.withTimeout;
    vi.spyOn(proto, "withTimeout").mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (args[2] === label) resolve();
      return original.apply(this, args);
    });
  });
}

const result = (id: number | undefined, value: unknown) =>
  sseFrame(JSON.stringify({ jsonrpc: "2.0", id, result: value }));

describe("helpers", () => {
  test("puzzleResourceUri builds the puzzlebox resource URI", () => {
    expect(puzzleResourceUri("0x1")).toBe("puzzlebox:/puzzle/0x1");
  });

  test("asSnapshot keeps well-typed fields and drops the rest", () => {
    expect(asSnapshot({ currentState: "A", availableActions: ["X", 3, "Y"] })).toEqual({
      currentState: "A",
      availableActions: ["X", "Y"],
    });
    expect(asSnapshot({ currentState: 7, availableActions: "nope" })).toEqual({
      currentState: undefined,
      availableActions: undefined,
    });
    expect(asSnapshot(null)).toEqual({ currentState: undefined, availableActions: undefined });
  });
});

describe("SseClient", () => {
  test("initializes, calls a tool and receives subscribed resource updates", async () => {
    const m = await mock();
    const client = track(new SseClient(m.url));
    await client.initialize();
    expect(await client.callTool("get_puzzle_snapshot", { puzzleId: "p" })).toEqual({
      currentState: "PLAYING",
      availableActions: ["END_GAME"],
    });

    const uri = puzzleResourceUri("p");
    let updates = 0;
    expect(await client.subscribe(uri, () => updates++)).toBe(true);
    const arrived = new Promise<void>((resolve) => {
      const again = () => {
        if (updates > 0) resolve();
        else setImmediate(again);
      };
      again();
    });
    m.notifyUpdated("puzzlebox:/puzzle/someone-else"); // not ours: ignored
    m.notifyUpdated(uri);
    await arrived;
    expect(updates).toBe(1);
  });

  test("a refused subscription reports false and is forgotten", async () => {
    const ready = armed("resources/subscribe");
    const s = await scriptedSse({
      onRequest: (msg, write) => {
        if (msg.method === "resources/subscribe") {
          void ready.then(() =>
            write(sseFrame(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } }))),
          );
        } else if (msg.id !== undefined) {
          write(result(msg.id, {}));
        }
      },
    });
    const client = track(new SseClient(s.url));
    await client.initialize();
    expect(await client.subscribe("puzzlebox:/puzzle/p", () => {})).toBe(false);
  });

  test("tolerates frames it does not understand and surfaces JSON-RPC errors", async () => {
    const ready = armed("tools/call");
    const s = await scriptedSse({
      onRequest: (msg, write) => {
        if (msg.method === "tools/call") {
          void ready.then(() => answerWithNoise(msg.id, write));
        } else if (msg.id !== undefined) {
          write(result(msg.id, {}));
        }
      },
    });
    const client = track(new SseClient(s.url));
    await client.initialize();
    await expect(client.callTool("anything", {})).rejects.toThrow("JSON-RPC -32000: boom");
  });

  function answerWithNoise(id: number | undefined, write: (chunk: string) => void): void {
    write(": a comment-only frame\n\n"); // no data
    write(sseFrame("not json")); // not JSON-RPC
    write(sseFrame(JSON.stringify({ jsonrpc: "2.0", method: "notifications/resources/updated", params: {} })));
    write(sseFrame(JSON.stringify({ jsonrpc: "2.0", method: "notifications/resources/updated" })));
    write(result(9999, "stray")); // an id nobody is waiting for
    write(result("string-id" as unknown as number, "stray"));
    write(sseFrame(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } })));
  }

  test("parses tool results: JSON text, plain text, and non-content results", async () => {
    const replies: unknown[] = [
      { content: [{ type: "text", text: "plain words" }] },
      { content: [{ type: "image" }] },
      { other: true },
      null,
    ];
    const s = await scriptedSse({
      onRequest: (msg, write) => {
        if (msg.method === "tools/call") write(result(msg.id, replies.shift()));
        else if (msg.id !== undefined) write(result(msg.id, {}));
      },
    });
    const client = track(new SseClient(s.url));
    await client.initialize();
    expect(await client.callTool("t", {})).toBe("plain words");
    expect(await client.callTool("t", {})).toEqual({ content: [{ type: "image" }] });
    expect(await client.callTool("t", {})).toEqual({ other: true });
    expect(await client.callTool("t", {})).toBeNull();
  });

  test("a POST answered 200 is accepted like a 202", async () => {
    const s = await scriptedSse({
      postStatus: 200,
      onRequest: (msg, write) => {
        if (msg.id !== undefined) write(result(msg.id, {}));
      },
    });
    const client = track(new SseClient(s.url));
    await expect(client.initialize()).resolves.toBeUndefined();
  });

  test("a POST refused by the server fails the request", async () => {
    const s = await scriptedSse({ postStatus: 500, onRequest: () => {} });
    // Not closed: when the POST fails, request() leaves its entry in `pending` with nobody awaiting it, so a later
    // close() would reject it unhandled. That is the code as it stands (noted in the PR); the test leaves it alone.
    const client = new SseClient(s.url);
    await expect(client.initialize()).rejects.toThrow("POST /message failed: HTTP 500");
  });

  test("a non-OK stream response fails initialize", async () => {
    const s = await server((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await expect(track(new SseClient(s.url)).initialize()).rejects.toThrow("SSE connect failed: HTTP 500");
  });

  test("an OK stream response without a body fails initialize", async () => {
    const s = await server((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await expect(track(new SseClient(s.url)).initialize()).rejects.toThrow("SSE connect failed: HTTP 204");
  });

  test("a refused connection fails initialize", async () => {
    const s = await server(() => {});
    const url = s.url;
    await s.close();
    await expect(track(new SseClient(url)).initialize()).rejects.toThrow();
  });

  test("a non-Error rejection from fetch is wrapped in an Error", async () => {
    vi.stubGlobal("fetch", () => Promise.reject("plain string"));
    await expect(track(new SseClient("http://127.0.0.1:9")).initialize()).rejects.toThrow("plain string");
  });

  test("a stream that ends after the announcement leaves requests to time out or close", async () => {
    const s = await scriptedSse({ endAfterAnnounce: true, onRequest: () => {} });
    const client = new SseClient(s.url);
    const init = client.initialize();
    // Wait (on a condition, not a clock) until initialize is waiting on a response that can never arrive;
    // close() must then reject it.
    const pending = (client as unknown as { pending: Map<number, unknown> }).pending;
    await vi.waitFor(() => expect(pending.size).toBe(1), { interval: 5 });
    client.close();
    await expect(init).rejects.toThrow("client closed");
  });

  test("a request before initialize fails", async () => {
    // Not closed: when the POST fails, request() leaves its entry in `pending` with nobody awaiting it, so a later
    // close() would reject it unhandled. That is the code as it stands (noted in the PR); the test leaves it alone.
    const client = new SseClient("http://127.0.0.1:9");
    await expect(client.callTool("t", {})).rejects.toThrow("SSE transport not initialized");
  });

  test("withTimeout rejects with a labelled timeout", async () => {
    const client = track(new SseClient("http://127.0.0.1:9"));
    const timed = (
      client as unknown as { withTimeout: (p: Promise<unknown>, ms: number, label: string) => Promise<unknown> }
    ).withTimeout(new Promise(() => {}), 1, "slow thing");
    await expect(timed).rejects.toThrow("slow thing timed out after 1ms");
  });
});

describe("StreamableHttpClient", () => {
  test("initializes against the mock and carries the session id afterwards", async () => {
    const seen: Array<string | undefined> = [];
    const s = await server(async (req, res) => {
      seen.push(req.headers["mcp-session-id"] as string | undefined);
      const msg = JSON.parse(await readBody(req)) as { id?: number; method?: string };
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (msg.method === "initialize") headers["mcp-session-id"] = "sess-42";
      res.writeHead(200, headers);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "{}" }] } }));
    });
    const client = track(new StreamableHttpClient(`${s.url}/mcp`));
    await client.initialize();
    expect(await client.callTool("t", {})).toEqual({});
    expect(seen).toEqual([undefined, "sess-42", "sess-42"]);
  });

  test("finds its answer in a one-shot SSE body, skipping frames that are not it", async () => {
    const s = await server(async (req, res) => {
      const msg = JSON.parse(await readBody(req)) as { id?: number };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(["event: ping\n\n", sseFrame("not json"), result(-1, "other"), result(msg.id, { content: [] })].join(""));
    });
    const client = track(new StreamableHttpClient(`${s.url}/mcp`));
    expect(await client.callTool("t", {})).toEqual({ content: [] });
  });

  test("an SSE body without our answer is an error", async () => {
    const s = await server(async (req, res) => {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(result(-1, "other"));
    });
    const client = track(new StreamableHttpClient(`${s.url}/mcp`));
    await expect(client.callTool("t", {})).rejects.toThrow("tools/call: no response frame for id 1");
  });

  test("a JSON body without a content-type is still read", async () => {
    const s = await server(async (req, res) => {
      const msg = JSON.parse(await readBody(req)) as { id?: number };
      res.writeHead(200);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "raw" }));
    });
    const client = track(new StreamableHttpClient(`${s.url}/mcp`));
    expect(await client.callTool("t", {})).toBe("raw");
  });

  test("HTTP and JSON-RPC errors are thrown", async () => {
    let mode: "http" | "rpc" = "http";
    const s = await server(async (req, res) => {
      const msg = JSON.parse(await readBody(req)) as { id?: number };
      if (mode === "http") {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "bad params" } }));
    });
    const client = track(new StreamableHttpClient(`${s.url}/mcp`));
    await expect(client.initialize()).rejects.toThrow("initialize failed: HTTP 503");
    mode = "rpc";
    await expect(client.callTool("t", {})).rejects.toThrow("JSON-RPC -32602: bad params");
  });

  test("has no push channel: subscribe reports false", async () => {
    const client = new StreamableHttpClient("http://127.0.0.1:9/mcp");
    expect(await client.subscribe("puzzlebox:/puzzle/p", () => {})).toBe(false);
    expect(() => client.close()).not.toThrow();
  });
});

describe("connect", () => {
  test("auto prefers SSE when the server speaks it", async () => {
    const m = await mock();
    const logs: string[] = [];
    const client = track(await connect(m.url, "auto", (l) => logs.push(l)));
    expect(client).toBeInstanceOf(SseClient);
    expect(logs).toEqual([`connected via SSE: ${m.url}`]);
  });

  test("auto falls back to streamableHttp when SSE fails", async () => {
    const m = await mock();
    const s = await server(async (req, res) => {
      // Forward /mcp to the mock; refuse /sse.
      if (req.url === "/sse") {
        res.writeHead(404);
        res.end();
        return;
      }
      const upstream = await fetch(`${m.url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await readBody(req),
      });
      res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "text/plain" });
      res.end(await upstream.text());
    });
    const logs: string[] = [];
    const client = track(await connect(s.url, "auto", (l) => logs.push(l)));
    expect(client).toBeInstanceOf(StreamableHttpClient);
    expect(logs[0]).toContain("SSE connect failed (SSE connect failed: HTTP 404); trying streamableHttp");
    expect(logs[1]).toBe(`connected via streamableHttp: ${s.url}/mcp`);
  });

  test("auto logs a non-Error SSE failure as-is", async () => {
    const m = await mock();
    vi.spyOn(SseClient.prototype, "initialize").mockRejectedValue("not an error");
    const logs: string[] = [];
    track(await connect(m.url, "auto", (l) => logs.push(l)));
    expect(logs[0]).toBe("SSE connect failed (not an error); trying streamableHttp");
  });

  test("a pinned SSE transport does not fall back", async () => {
    const s = await server((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await expect(connect(s.url, "sse")).rejects.toThrow("SSE connect failed: HTTP 404");
  });

  test("a pinned http transport skips SSE, and the default logger is silent", async () => {
    const m = await mock();
    const client = track(await connect(m.url, "http"));
    expect(client).toBeInstanceOf(StreamableHttpClient);
  });
});
