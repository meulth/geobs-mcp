import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createMcpHandler } from "agents/mcp/server";
import type { CatalogReader } from "../catalog";
import { createGeoBsServer } from "../mcp/server";
import { observeHttp, type TelemetrySink } from "../telemetry";

export const MAX_REQUEST_BYTES = 1_000_000;
type Options = { hosts: string[]; origins: string[]; apiKey?: string; catalog: CatalogReader; log?: TelemetrySink };

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export function createNodeServer(options: Options) {
  const controllers = new Set<AbortController>();
  const server = createServer({ maxHeaderSize: 16_384 }, (incoming, outgoing) => {
    void serve(incoming, outgoing).catch(() => {
      if (!outgoing.headersSent) { outgoing.writeHead(500, { "content-type": "application/json" }); outgoing.end('{"error":"internal_error"}'); }
      else outgoing.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  async function serve(incoming: IncomingMessage, outgoing: ServerResponse) {
    const abort = new AbortController();
    controllers.add(abort);
    const disconnected = () => { if (!outgoing.writableFinished) abort.abort(); };
    incoming.once("aborted", disconnected);
    outgoing.once("close", disconnected);
    try {
      const host = incoming.headers.host?.toLowerCase() ?? "";
      // Forwarded headers are deliberately ignored. The connector must preserve
      // the configured public Host or explicitly override it to a local Host.
      if (!options.hosts.includes(host)) { outgoing.writeHead(403); outgoing.end(); return; }
      const origin = incoming.headers.origin;
      if (origin !== undefined && !options.origins.includes(origin)) { outgoing.writeHead(403); outgoing.end(); return; }
      if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) { outgoing.writeHead(400); outgoing.end(); return; }
      const url = new URL(incoming.url, `http://${host}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const method = incoming.method ?? "GET";
      const parts: Buffer[] = [];
      let bytes = 0;
      if (method !== "GET" && method !== "HEAD") {
        for await (const part of incoming) {
          bytes += part.length;
          if (bytes > MAX_REQUEST_BYTES) { outgoing.writeHead(413, { connection: "close" }); outgoing.end(); return; }
          parts.push(part);
        }
      }
      const body = parts.length ? new Uint8Array(Buffer.concat(parts)) : undefined;
      const request = new Request(url, { method, headers, body, signal: abort.signal });
      const response = await observeHttp(request, async () => {
        if (url.pathname === "/" && method === "GET") return json({ name: "geobs-mcp", version: "0.1.0", status: "ok", mcp: "/mcp", authentication: "none" });
        if (url.pathname === "/health/live" && method === "GET") return json({ status: "ok" });
        if (url.pathname === "/health/ready" && method === "GET") {
          try { await options.catalog.get(); return json({ status: "ok" }); }
          catch { return json({ status: "not_ready" }, 503); }
        }
        if (url.pathname !== "/mcp") return json({ error: "not_found" }, 404);
        if (method === "OPTIONS") return new Response(null, { status: 204 });
        const handler = createMcpHandler(() => createGeoBsServer({ GEOBS_API_KEY: options.apiKey }, options.catalog), {
          route: "/mcp", legacy: "stateless", responseMode: "auto", corsOptions: false,
          allowedHostnames: options.hosts.map(value => new URL(`http://${value}`).hostname),
          allowedOriginHostnames: options.origins.map(value => new URL(value).hostname)
        });
        return handler.fetch(request);
      }, options.log);
      response.headers.set("cache-control", "no-store");
      response.headers.set("x-content-type-options", "nosniff");
      if (origin) {
        response.headers.set("access-control-allow-origin", origin);
        response.headers.set("vary", "Origin");
        response.headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
        response.headers.set("access-control-allow-headers", "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id");
      }
      if (response.headers.get("content-type")?.includes("text/event-stream")) response.headers.set("x-accel-buffering", "no");
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => { responseHeaders[name] = value; });
      outgoing.writeHead(response.status, responseHeaders);
      if (response.body) {
        outgoing.flushHeaders();
        await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), outgoing, { signal: abort.signal });
      } else outgoing.end();
    } finally {
      incoming.removeListener("aborted", disconnected);
      outgoing.removeListener("close", disconnected);
      controllers.delete(abort);
    }
  }

  return {
    server,
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await closed;
    }
  };
}
