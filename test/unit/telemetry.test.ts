import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGeoBsServer } from "../../src/mcp/server";
import { observeHttp, withTelemetry } from "../../src/telemetry";
import { fetchJson } from "../../src/http";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("privacy-safe telemetry", () => {
  it("keeps concurrent requests isolated and never logs URL, headers or upstream content", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const secret = "private-address-and-token";
    await Promise.all([200, 429].map(status => observeHttp(
      new Request(`https://example.test/mcp?query=${secret}`, { headers: { authorization: secret } }),
      async () => {
        try {
          await fetchJson(`https://api.geo.bs.ch/search/v2/search?query=${secret}`, {
            headers: { apikey: secret },
            fetcher: async () => new Response(JSON.stringify({ secret }), { status })
          });
        } catch { /* MCP can return an error inside an HTTP 200. */ }
        return new Response("ok");
      }
    )));
    const events = log.mock.calls.map(([event]) => event);
    expect(events).toHaveLength(4);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(new Set(events.map(e => e.event_id)).size).toBe(4);
    const ids = [...new Set(events.map(e => e.request_id))];
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(events.filter(e => e.request_id === id).map(e => e.event)).toEqual(["geobs_upstream", "http_request"]);
    }
    expect(events.find(e => e.status === 429)).toMatchObject({
      upstream: "search", outcome: "error", error_code: "RATE_LIMIT"
    });
    expect(events.filter(e => e.event === "http_request").every(e => e.outcome === "success")).toBe(true);
  });

  it("records real MCP success and application errors, excluding schema-rejected executions", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetcher = vi.fn(async () => Response.json([
      { label: "Basel", layer_name: "Adresse", geom: "POINT (2611234 1267890)" }
    ]));
    vi.stubGlobal("fetch", fetcher);
    const server = createGeoBsServer({ GEOBS_API_KEY: "secret" });
    const client = new Client({ name: "telemetry-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    try {
      await withTelemetry(async () => {
        await client.callTool({ name: "search_api_v2", arguments: { query: "Basel" } });
        fetcher.mockImplementation(async () => new Response("secret", { status: 503 }));
        await client.callTool({ name: "search_api_v2", arguments: { query: "Basel" } });
        await client.callTool({ name: "search_api_v2", arguments: {} });
      });
      const tools = log.mock.calls.map(([e]) => e).filter(e => e.event === "mcp_tool");
      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({ tool: "search_api_v2", outcome: "success", output_bytes: expect.any(Number) });
      expect(tools[1]).toMatchObject({ tool: "search_api_v2", outcome: "error", error_code: "UPSTREAM_UNAVAILABLE" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    } finally { await client.close(); await server.close(); }
  });

  it("records JSON failures after HTTP 200 and body-read timeouts as upstream errors", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await withTelemetry(async () => {
      await expect(fetchJson("https://api.geo.bs.ch/stac/v1/collections", {
        fetcher: async () => new Response("invalid-json")
      })).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
      await expect(fetchJson("https://api.geo.bs.ch/stac/v1/collections", {
        timeoutMs: 5,
        fetcher: async (_, init) => new Response(new ReadableStream({ start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("secret")), { once: true });
        } }))
      })).rejects.toMatchObject({ code: "TIMEOUT" });
    });
    expect(log.mock.calls.map(([e]) => [e.status, e.outcome, e.error_code])).toEqual([
      [200, "error", "INVALID_UPSTREAM_RESPONSE"], [200, "error", "TIMEOUT"]
    ]);
  });

  it("preserves responses and exceptions even when the log sink fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => { throw new Error("sink unavailable"); });
    const request = new Request("https://example.test/arbitrary-private-path");
    const response = new Response("ok");
    expect(await observeHttp(request, async () => response)).toBe(response);
    const failure = new Error("internal-detail");
    await expect(observeHttp(request, async () => { throw failure; })).rejects.toBe(failure);
    expect(log.mock.calls[1]?.[0]).toMatchObject({ route: "other", status: 500, outcome: "error" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("internal-detail");
  });
});
