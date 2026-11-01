import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createNodeServer, MAX_REQUEST_BYTES } from "../../src/node/http";
import { createCatalogSnapshot, type CatalogReader } from "../../src/catalog";
import { nodeConfig } from "../../src/node/config";
import worker from "../../src/index";

const apps: ReturnType<typeof createNodeServer>[] = [];
const toolNames = ["search_api_v2", "search_datasets_ogc", "get_dataset_stac", "query_features_ogc", "get_property_info"].sort();
async function fixture(reader?: CatalogReader) {
  const snapshot = await createCatalogSnapshot([{ id: "ch.bs.strassennamen_stna", title: "Strassennamen" }]);
  const catalog = reader ?? { get: vi.fn(async () => snapshot) };
  const hosts: string[] = ["geo.example.test"];
  const logs: Record<string, unknown>[] = [];
  const app = createNodeServer({ hosts, origins: ["https://geo.example.test"], catalog, log: event => logs.push(event) });
  apps.push(app);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const { port } = app.server.address() as { port: number };
  hosts.push(`127.0.0.1:${port}`);
  return { app, catalog, logs, base: `http://127.0.0.1:${port}`, port };
}
afterEach(async () => { for (const app of apps.splice(0)) if (app.server.listening) await app.close(); });

function raw(port: number, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: body ? "POST" : "GET", headers }, response => {
      let data = "";
      response.on("data", part => { data += part; });
      response.on("end", () => resolve({ status: response.statusCode!, body: data }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("Node MCP adapter over real loopback HTTP", () => {
  it.each(["legacy", "auto"] as const)("serves all five tools and full text/structured output with %s negotiation", async mode => {
    const { base, logs } = await fixture();
    const types: string[] = [];
    const localFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      types.push(response.headers.get("content-type") ?? "");
      return response;
    };
    const client = new Client({ name: "offline-node-test", version: "1" }, { versionNegotiation: { mode } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { fetch: localFetch }));
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name).sort()).toEqual(toolNames);
      if (mode === "legacy") {
        const workerResponse = await worker.fetch(new Request("https://geo-example.workers.dev/mcp", {
          method: "POST", headers: { host: "geo-example.workers.dev", "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        }), {}, {} as ExecutionContext);
        expect(workerResponse.status).toBe(200);
        const frames = (await workerResponse.text()).split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
        expect(tools.tools).toEqual(frames.find(frame => frame.result?.tools)?.result.tools);
      }
      const result = await client.callTool({ name: "search_datasets_ogc", arguments: { query: "Strassennamen" } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ resultCount: 1 });
      expect(JSON.stringify(result.content)).toContain("ch.bs.strassennamen_stna");
      expect(types.some(type => type.includes(mode === "legacy" ? "text/event-stream" : "application/json"))).toBe(true);
      expect(logs.filter(event => event.event === "mcp_tool")).toHaveLength(1);
    } finally { await client.close(); }
  });

  it("reports minimal local health and readiness without any upstream request", async () => {
    const { base, catalog } = await fixture();
    const live = await fetch(`${base}/health/live`);
    expect(await live.json()).toEqual({ status: "ok" });
    expect(catalog.get).not.toHaveBeenCalled();
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok" });
    expect(catalog.get).toHaveBeenCalledOnce();
    expect((await fetch(`${base}/not-a-route`)).status).toBe(404);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });

  it("keeps liveness while failing readiness when the catalog is unavailable", async () => {
    const { base } = await fixture({ get: async () => { throw new Error("internal file detail"); } });
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready" });
  });

  it("requires exact Host authority, ignores forwarded headers and rejects foreign/null Origins", async () => {
    const { port } = await fixture();
    expect((await raw(port, "/health/live", { host: "geo.example.test" })).status).toBe(200);
    expect((await raw(port, "/health/live", { host: "GEO.EXAMPLE.TEST" })).status).toBe(200);
    for (const host of ["evil.example.test", "geo.example.test:443", "localhost:8080"]) {
      expect((await raw(port, "/health/live", { host, "x-forwarded-host": "geo.example.test" })).status).toBe(403);
    }
    for (const origin of ["null", "", "https://evil.example.test", "http://geo.example.test", "https://geo.example.test:444"]) {
      expect((await raw(port, "/mcp", { host: "geo.example.test", origin })).status).toBe(403);
    }
    const allowed = await raw(port, "/health/live", { host: "geo.example.test", origin: "https://geo.example.test" });
    expect(allowed.status).toBe(200);
  });

  it("returns a restricted preflight without requiring authentication", async () => {
    const { base } = await fixture();
    const response = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://geo.example.test" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://geo.example.test");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects oversized request bodies before invoking a tool", async () => {
    const { base, logs } = await fixture();
    const response = await fetch(`${base}/mcp`, { method: "POST", body: "x".repeat(MAX_REQUEST_BYTES + 1) });
    expect(response.status).toBe(413);
    expect(logs.filter(event => event.event === "mcp_tool")).toHaveLength(0);
  });

  it("finishes a legacy SSE result and closes cleanly", async () => {
    const { base, app } = await fixture();
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("query_features_ogc");
    await app.close();
  });

  it("cancels an in-flight SSE exchange and shuts down without holding a connection", async () => {
    const snapshot = await createCatalogSnapshot([{ id: "ch.bs.strassennamen_stna", title: "Strassennamen" }]);
    let started!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const { base, app } = await fixture({ get: async () => { started(); await blocked; return snapshot; } });
    const controller = new AbortController();
    const exchange = fetch(`${base}/mcp`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_datasets_ogc", arguments: { query: "Strassennamen" } } }) }).then(response => response.text());
    const rejected = expect(exchange).rejects.toThrow();
    await ready;
    controller.abort();
    await rejected;
    finish();
    await app.close();
  });

  it("validates operator Host/Origin configuration", () => {
    const config = nodeConfig({ GEOBS_ALLOWED_HOSTS: "geo.example.test,127.0.0.1:8080", GEOBS_ALLOWED_ORIGINS: "https://geo.example.test" });
    expect(config.hosts).toEqual(["geo.example.test", "127.0.0.1:8080"]);
    for (const invalid of ["*", "user@host", "host/path"]) expect(() => nodeConfig({ GEOBS_ALLOWED_HOSTS: invalid })).toThrow();
    for (const invalid of ["null", "*", "http://geo.example.test", "https://geo.example.test/"]) expect(() => nodeConfig({ GEOBS_ALLOWED_ORIGINS: invalid })).toThrow();
  });
});
