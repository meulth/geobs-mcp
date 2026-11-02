import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { z } from "zod";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createNodeServer } from "../../src/node/http";
import { createCatalogSnapshot } from "../../src/catalog";
import { createGeoBsServer } from "../../src/mcp/server";
import { getToolDocumentation } from "../../src/mcp/register";
import { DOCS_PROTOCOL_VERSION, MCP_ACCEPT } from "../../src/node/openapi";
import { nodeConfig } from "../../src/node/config";
import { CRS } from "../../src/config";

const collections = [
  { id: "ch.bs.strassennamen_stna", title: "Strassennamen", crs: [CRS[2056]] },
  { id: "ch.bs.liegenschaften_las", title: "Liegenschaft Basel-Stadt", crs: [CRS[2056]] }
];
const apps: ReturnType<typeof createNodeServer>[] = [];
async function fixture(basePath = "", key?: string) {
  const snapshot = await createCatalogSnapshot(collections);
  const catalog = { get: vi.fn(async () => snapshot) };
  const hosts: string[] = [];
  const origins: string[] = [];
  const app = createNodeServer({ hosts, origins, publicBasePath: basePath, apiKey: key, catalog, log: () => {} });
  apps.push(app);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const { port } = app.server.address() as { port: number };
  hosts.push(`127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;
  origins.push(base);
  return { base, catalog };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.close();
});
async function rpc(base: string, message: unknown) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: MCP_ACCEPT, "MCP-Protocol-Version": DOCS_PROTOCOL_VERSION },
    body: JSON.stringify(message)
  });
  const text = await response.text();
  const frames = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
    : [JSON.parse(text)];
  return { response, text, frame: frames.find(frame => frame.result || frame.error) };
}
function mockGeoBs() {
  const original = globalThis.fetch;
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1") return original(input, init);
    expect(url.origin).toBe("https://api.geo.bs.ch");
    calls.push(url.pathname);
    if (url.pathname === "/search/v2/search") return Response.json([{ label: "Dufourstrasse 40 (synthetic)", layer_name: "Adresse", geom: "POINT (2611300 1266600)" }]);
    if (url.pathname === "/stac/v1/collections/STNA") return Response.json({ id: "STNA", title: "Strassennamen", links: [] });
    if (url.pathname === "/stac/v1/collections/STNA/items") return Response.json({ features: [] });
    if (url.pathname.includes("/grundstueckinfo/")) return Response.json({ Date: "synthetic", RealEstates: [{ Egrid: "CH776779888908", Buildings: [], Landcovers: [] }] });
    const collection = collections.find(entry => url.pathname === `/ogc/v1/wfs3/collections/${entry.id}`);
    if (collection) return Response.json(collection);
    if (url.pathname.endsWith("/items")) return Response.json({ type: "FeatureCollection", numberMatched: 1, numberReturned: 1, features: [{
      type: "Feature", id: "synthetic-1", properties: { egrid: "CH776779888908", name: "Synthetic" }, geometry: { type: "Point", coordinates: [2611300, 1266600] }
    }] });
    throw new Error(`Unexpected synthetic request: ${url.pathname}`);
  });
  return calls;
}

describe("public Node documentation and gateway routing", () => {
  it.each(["", "/geobs-mcp/v1"])("validates OpenAPI 3.1 and compares schemas with the live MCP registry (%s)", async prefix => {
    const { base, catalog } = await fixture(prefix);
    const response = await fetch(`${base}${prefix}/openapi.json`);
    expect(response.status).toBe(200);
    const spec: any = await response.json();
    expect(spec.openapi).toBe("3.1.0");
    await SwaggerParser.validate(structuredClone(spec), { resolve: { external: false } });
    expect(spec.servers).toEqual([{ url: prefix || "/", description: "Same-origin public base path" }]);
    expect(Object.keys(spec.paths)).toEqual(["/mcp"]);
    expect(catalog.get).not.toHaveBeenCalled();
    const metadata = getToolDocumentation(createGeoBsServer({}, catalog));
    const { frame } = await rpc(`${base}${prefix}`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(frame.result.tools).toHaveLength(5);
    for (const tool of frame.result.tools) {
      const source = metadata.find(entry => entry.name === tool.name)!;
      expect(tool.inputSchema).toEqual(z.toJSONSchema(source.inputSchema, { io: "input" }));
      expect(tool.outputSchema).toEqual(z.toJSONSchema(source.outputSchema, { io: "output" }));
      expect(spec.components.schemas[`${tool.name}_request`].description).toBe(tool.description);
      expect(spec.components.schemas[`${tool.name}_request`].properties.params.properties.arguments.$ref).toBe(`#/components/schemas/${tool.name}_input`);
      expect(Object.keys(spec.components.schemas[`${tool.name}_input`].properties)).toEqual(Object.keys(tool.inputSchema.properties));
    }
  });

  it("runs every published example through the actual JSON-RPC handler with synthetic upstream data", async () => {
    const { base } = await fixture("/geobs-mcp/v1", "synthetic-test-key");
    const calls = mockGeoBs();
    const spec: any = await (await fetch(`${base}/openapi.json`)).json();
    expect(JSON.stringify(spec)).not.toContain("synthetic-test-key");
    const examples = spec.paths["/mcp"].post.requestBody.content["application/json"].examples;
    expect(Object.keys(examples)).toHaveLength(7);
    for (const [name, example] of Object.entries(examples) as [string, { value: unknown }][]) {
      const { response, frame } = await rpc(`${base}/geobs-mcp/v1`, example.value);
      expect(response.status, name).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      expect(frame.error, name).toBeUndefined();
      expect(frame.result.isError, name).not.toBe(true);
      if (name !== "initialize" && name !== "tools_list") expect(frame.result.structuredContent, name).toBeDefined();
    }
    expect(calls.some(path => path.startsWith("/search/v2/"))).toBe(true);
    expect(calls.some(path => path.includes("/grundstueckinfo/"))).toBe(true);
  });

  it.each(["/mcp", "/geobs-mcp/v1/mcp"])("retains modern JSON negotiation on %s", async path => {
    const { base } = await fixture("/geobs-mcp/v1");
    const types: string[] = [];
    const client = new Client({ name: "docs-compatibility", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { fetch: async (input, init) => {
      const response = await fetch(input, init); types.push(response.headers.get("content-type") ?? ""); return response;
    } }));
    try {
      expect((await client.listTools()).tools).toHaveLength(5);
      expect((await client.callTool({ name: "search_datasets_ogc", arguments: { query: "Strassennamen" } })).isError).not.toBe(true);
      expect(types.some(type => type.includes("application/json"))).toBe(true);
    } finally { await client.close(); }
  });

  it("serves local UI/assets through preserved and stripped prefix paths without external dependencies", async () => {
    const { base } = await fixture("/geobs-mcp/v1");
    for (const path of ["/", "/docs", "/docs/", "/geobs-mcp/v1", "/geobs-mcp/v1/", "/geobs-mcp/v1/docs"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('/geobs-mcp/v1/docs/swagger-ui-bundle.js');
      expect(html).not.toMatch(/https?:\/\//);
      expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    }
    for (const prefix of ["", "/geobs-mcp/v1"]) {
      for (const [file, type] of [["swagger-ui.css", "text/css"], ["swagger-ui-bundle.js", "text/javascript"], ["swagger-initializer.js", "text/javascript"]]) {
        const response = await fetch(`${base}${prefix}/docs/${file}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(type);
        expect((await response.text()).length).toBeGreaterThan(100);
      }
    }
    const init = await (await fetch(`${base}/docs/swagger-initializer.js`)).text();
    expect(init).toContain('url: "/geobs-mcp/v1/openapi.json"');
    expect(init).toContain("validatorUrl: null");
    expect(init).toContain(MCP_ACCEPT);
    expect(init).toContain(DOCS_PROTOCOL_VERSION);
    expect((await fetch(`${base}/openapi.json`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${base}/docs`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/docs/../../package.json`)).status).toBe(404);
    expect((await fetch(`${base}/other/v1/mcp`)).status).toBe(404);
  });

  it("keeps tool failures separate from transport failures and rejects foreign Origins on docs", async () => {
    const { base } = await fixture();
    const result = await rpc(base, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_api_v2", arguments: { query: "Basel" } } });
    expect(result.response.status).toBe(200);
    expect(result.frame.result.isError).toBe(true);
    expect(result.text).toContain("MISSING_API_KEY");
    expect((await fetch(`${base}/docs`, { headers: { origin: "https://foreign.example.test" } })).status).toBe(403);
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: MCP_ACCEPT }, body: "{" })).status).toBe(400);
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "text/plain" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).status).toBe(406);
  });

  it.each(["https://example.test/prefix", "//host/path", "/prefix/", "/../prefix", "/x?y", "/x#y", "/x%2Fy", "/mcp", "/docs/v1", "/health"])("rejects an ambiguous public prefix %s", prefix => {
    expect(() => nodeConfig({ GEOBS_PUBLIC_BASE_PATH: prefix })).toThrow("GEOBS_PUBLIC_BASE_PATH");
  });
});
