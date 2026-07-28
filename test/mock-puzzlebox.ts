// Test fixture — a minimal in-process puzzlebox stand-in.
// Speaks just enough streamableHttp JSON-RPC for the sentinel: initialize,
// notifications/initialized, tools/call get_puzzle_snapshot. State is mutable
// from the test so dwell and transitions can be simulated.

export interface MockPuzzlebox {
  url: string; // base URL, e.g. http://localhost:PORT
  setState(state: string, actions?: string[]): void;
  snapshotCalls: () => number;
  stop(): void;
}

export function startMockPuzzlebox(initialState: string, actions: string[] = []): MockPuzzlebox {
  let currentState = initialState;
  let availableActions = actions;
  let snapshotCallCount = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/mcp") {
        return new Response("not found", { status: 404 });
      }
      const msg = (await req.json()) as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };

      // Notifications carry no id — acknowledge and move on.
      if (msg.id === undefined) return new Response(null, { status: 202 });

      if (msg.method === "initialize") {
        return jsonRpc(msg.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {}, resources: { subscribe: true } },
          serverInfo: { name: "mock-puzzlebox", version: "0.0.1" },
        }, { "mcp-session-id": "mock-session-1" });
      }

      if (msg.method === "tools/call" && msg.params?.name === "get_puzzle_snapshot") {
        snapshotCallCount++;
        const body = JSON.stringify({ currentState, availableActions });
        return jsonRpc(msg.id, { content: [{ type: "text", text: body }] });
      }

      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });

  function jsonRpc(id: number, result: unknown, extraHeaders: Record<string, string> = {}): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { "Content-Type": "application/json", ...extraHeaders },
    });
  }

  return {
    url: `http://localhost:${server.port}`,
    setState(state, newActions = []) {
      currentState = state;
      availableActions = newActions;
    },
    snapshotCalls: () => snapshotCallCount,
    stop: () => server.stop(true),
  };
}
