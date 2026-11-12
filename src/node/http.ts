import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createMcpHandler } from "agents/mcp/server";
import type { CatalogReader } from "../catalog";
import { createGeoBsServer } from "../mcp/server";
import { elapsed, observeHttp, recordEvent, type TelemetrySink } from "../telemetry";
import { getToolDocumentation } from "../mcp/register";
import { DEFAULT_MAX_CONCURRENT_REQUESTS, publicBasePath } from "./config";
import { buildOpenApi } from "./openapi";
import { documentationResponse } from "./docs";
import { createAccessGuard, type AccessConfiguration } from "./access";

export const MAX_REQUEST_BYTES = 1_000_000;
type Options = { hosts: string[]; origins: string[]; publicBasePath?: string; apiKey?: string; catalog: CatalogReader; log?: TelemetrySink; maxConcurrentRequests?: number; access?: AccessConfiguration };

// Telemetry labels the protected endpoint by its internal route, also when
// it is reached through the configured public-prefix alias.
function internalMcpUrl(url: URL) {
  const internal = new URL(url);
  internal.pathname = "/mcp";
  return internal;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export function createNodeServer(options: Options) {
  const basePath = publicBasePath(options.publicBasePath);
  const access = options.access ? createAccessGuard(options.access) : undefined;
  // Metadata only: creating a server registers schemas but executes no tools.
  const spec = buildOpenApi(getToolDocumentation(createGeoBsServer({}, options.catalog)), basePath, Boolean(access));
  const controllers = new Set<AbortController>();
  const maxConcurrent = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  let activeMcp = 0;
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
    let countedMcp = false;
    try {
      const host = incoming.headers.host?.toLowerCase() ?? "";
      // Forwarded headers are deliberately ignored. The connector must preserve
      // the configured public Host or explicitly override it to a local Host.
      if (!options.hosts.includes(host)) { outgoing.writeHead(403); outgoing.end(); return; }
      const origin = incoming.headers.origin;
      if (origin !== undefined && !options.origins.includes(origin)) { outgoing.writeHead(403); outgoing.end(); return; }
      if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) { outgoing.writeHead(400); outgoing.end(); return; }
      const url = new URL(incoming.url, `http://${host}`);
      const path = basePath && (url.pathname === basePath || url.pathname === `${basePath}/`)
        ? "/docs"
        : basePath && url.pathname.startsWith(`${basePath}/`) ? url.pathname.slice(basePath.length) : url.pathname;
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const method = incoming.method ?? "GET";
      if (path === "/mcp" && method !== "OPTIONS") {
        // Bound verification work and reject before buffering the request body.
        if (activeMcp >= maxConcurrent) {
          outgoing.writeHead(503, { "retry-after": "1", "cache-control": "no-store", "content-type": "application/json", connection: "close" });
          outgoing.end('{"error":"overloaded"}');
          return;
        }
        activeMcp++;
        countedMcp = true;
        const verifying = performance.now();
        const decision = access ? await access.verify(headers.get("cf-access-jwt-assertion") ?? undefined) : undefined;
        if (decision && !decision.ok) {
          // Only a request without any assertion gets the OAuth challenge. A
          // refused assertion came through the gateway's own OAuth boundary:
          // a 401 there makes clients discard a valid grant and loop through
          // login, so it is a 403 with a logged reason instead.
          const challenge = decision.reason === "missing";
          const reason = decision.reason;
          const verificationMs = elapsed(verifying);
          const denied = await observeHttp(new Request(internalMcpUrl(url), { method, signal: abort.signal }), async () => {
            recordEvent({ event: "access_denied", reason, outcome: "error", duration_ms: verificationMs });
            return json({ error: challenge ? "unauthorized" : "access_assertion_rejected" }, challenge ? 401 : 403);
          }, options.log);
          outgoing.writeHead(denied.status, {
            "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
            connection: "close", ...(challenge ? { "www-authenticate": access!.challenge } : {}),
            ...(origin ? { "access-control-allow-origin": origin, vary: "Origin",
              ...(challenge ? { "access-control-expose-headers": "WWW-Authenticate" } : {}) } : {})
          });
          outgoing.end(await denied.text());
          return;
        }
      }
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
      // The existing MCP handler keeps its internal /mcp route. This explicit
      // configured alias does not trust X-Forwarded-* or a client-supplied prefix.
      const internalUrl = new URL(url);
      if (path === "/mcp") internalUrl.pathname = path;
      const request = new Request(internalUrl, { method, headers, body, signal: abort.signal });
      const response = await observeHttp(request, async () => {
        if (access && (url.pathname === access.metadataPath || url.pathname === "/.well-known/oauth-protected-resource")) {
          return method === "GET" || method === "HEAD"
            ? method === "HEAD" ? new Response(null, { headers: { "content-type": "application/json" } }) : json(access.metadata)
            : json({ error: "method_not_allowed" }, 405);
        }
        if (method === "GET" || method === "HEAD") {
          // A stripping gateway forwards the public prefix root as '/'.
          const docs = path === "/openapi.json" ? json(spec) : documentationResponse(path === "/" && basePath ? "/docs" : path, basePath);
          if (docs) return method === "HEAD" ? new Response(null, { status: docs.status, headers: docs.headers }) : docs;
        }
        if (path === "/" && method === "GET") return json({ name: "geobs-mcp", version: "0.1.0", status: "ok", mcp: "/mcp", authentication: access ? "oauth" : "none", docs: `${basePath}/docs`, openapi: `${basePath}/openapi.json` });
        if (path === "/health/live" && method === "GET") return json({ status: "ok" });
        if (path === "/health/ready" && method === "GET") {
          try { await options.catalog.get(); return json({ status: "ok" }); }
          catch { return json({ status: "not_ready" }, 503); }
        }
        if (path !== "/mcp") return json({ error: "not_found" }, 404);
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
        response.headers.set("access-control-allow-headers", "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id");
        response.headers.set("access-control-expose-headers", "WWW-Authenticate");
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
      if (countedMcp) activeMcp--;
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
