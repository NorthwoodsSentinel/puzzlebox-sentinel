// Test helper: a throwaway loopback HTTP server on an ephemeral port, built on node:http so the suite runs under
// Vitest on Node (the sentinel itself runs on Bun; its client code only uses fetch, which both provide).
// close() destroys open sockets too, so a held-open SSE stream cannot keep a test file alive.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface TestServer {
  url: string; // base URL, e.g. http://127.0.0.1:PORT
  close(): Promise<void>;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export async function startHttpServer(handler: Handler): Promise<TestServer> {
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e: unknown) => {
      // A handler bug must surface as a failed request, never as a hung one.
      res.writeHead(500);
      res.end(String(e));
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function sseFrame(data: string, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`;
}
