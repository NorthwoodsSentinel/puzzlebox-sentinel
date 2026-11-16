// Test fixture — a minimal in-process puzzlebox stand-in.
// Speaks just enough MCP JSON-RPC for the sentinel, on both of its transports:
//   - streamableHttp: POST /mcp (initialize, notifications/initialized, tools/call get_puzzle_snapshot)
//   - SSE:            GET /sse announces /message; POSTed requests are answered on the stream, and
//                     resources/subscribe is accepted so notifyUpdated() can push resource updates.
// State is mutable from the test so dwell and transitions can be simulated.
// Built on node:http (test/helpers/http-server.ts) so it runs under Vitest on Node.

import type { ServerResponse } from "node:http";
import { readBody, sseFrame, startHttpServer } from "./helpers/http-server.ts";

export interface MockPuzzlebox {
  url: string; // base URL, e.g. http://127.0.0.1:PORT
  setState(state: string, actions?: string[]): void;
  snapshotCalls: () => number;
  // Push notifications/resources/updated for `uri` to every open SSE stream.
  notifyUpdated(uri: string): void;
  stop(): Promise<void>;
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; uri?: string };
}

export async function startMockPuzzlebox(initialState: string, actions: string[] = []): Promise<MockPuzzlebox> {
  let currentState = initialState;
  let availableActions = actions;
  let snapshotCallCount = 0;
  const streams = new Set<ServerResponse>();

  // The answer to one request, or null for a notification (no id).
  function answer(msg: RpcMessage): Record<string, unknown> | null {
    if (msg.id === undefined) return null;
    if (msg.method === "initialize") {
      return rpc(msg.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {}, resources: { subscribe: true } },
        serverInfo: { name: "mock-puzzlebox", version: "0.0.1" },
      });
    }
    if (msg.method === "tools/call" && msg.params?.name === "get_puzzle_snapshot") {
      snapshotCallCount++;
      const body = JSON.stringify({ currentState, availableActions });
      return rpc(msg.id, { content: [{ type: "text", text: body }] });
    }
    if (msg.method === "resources/subscribe") return rpc(msg.id, {});
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
  }

  const server = await startHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    if (req.method === "GET" && url.pathname === "/sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sseFrame("/message?sessionId=mock-sse-1", "endpoint"));
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/message") {
      const reply = answer(JSON.parse(await readBody(req)) as RpcMessage);
      res.writeHead(202);
      res.end();
      if (reply) for (const s of streams) s.write(sseFrame(JSON.stringify(reply), "message"));
      return;
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      const msg = JSON.parse(await readBody(req)) as RpcMessage;
      const reply = answer(msg);
      if (!reply) {
        // Notifications carry no id — acknowledge and move on.
        res.writeHead(202);
        res.end();
        return;
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      // The session id is issued on initialize, as the original Bun.serve mock did.
      if (msg.method === "initialize") headers["mcp-session-id"] = "mock-session-1";
      res.writeHead(200, headers);
      res.end(JSON.stringify(reply));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  function rpc(id: number, result: unknown): Record<string, unknown> {
    return { jsonrpc: "2.0", id, result };
  }

  return {
    url: server.url,
    setState(state, newActions = []) {
      currentState = state;
      availableActions = newActions;
    },
    snapshotCalls: () => snapshotCallCount,
    notifyUpdated(uri) {
      const note = { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } };
      for (const s of streams) s.write(sseFrame(JSON.stringify(note), "message"));
    },
    stop: () => server.close(),
  };
}
