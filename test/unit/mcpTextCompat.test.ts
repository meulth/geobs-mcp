import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { createGeoBsServer } from "../../src/mcp/server";
import { CRS, LIMITS } from "../../src/config";
import { jsonByteLength } from "../../src/mcp/results";

/**
 * Regression coverage for a real MCP-client incompatibility: some clients
 * (observed with Claude) only read a tool result's `content` text blocks and
 * never look at `structuredContent`, while others (observed with ChatGPT and
 * MCP Inspector) do read `structuredContent`. The bug was that this server's
 * `content` held only a short human summary ("Found 1 location result(s)…"),
 * so a text-only client had no coordinates, IDs or other values to carry
 * into the next tool call — even though the same data was present in
 * `structuredContent`.
 *
 * These tests connect a real MCP `Client` to the server over an in-memory
 * transport (so the exact wire-level `tools/call` result is exercised, not
 * just our own helper) and assert that every tool's `content` array also
 * carries the complete structured result as JSON text.
 */

function egridFor(url: URL): string | null {
  const match = url.pathname.match(/\/collections\/([^/]+)\/items$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

const STNA_COLLECTION_ID = "ch.bs.strassennamen_stna";
const PARCEL_COLLECTION_ID = "ch.bs.liegenschaften_las";
const CRS_2056 = CRS[2056];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function routeFetch(url: URL): Response | undefined {
  const { pathname, searchParams } = url;

  if (pathname === "/search/v2/search") {
    return jsonResponse([
      {
        label: "Schauenburgerstrasse 17, 4051 Basel ",
        layer_name: "Adresse",
        details: { street: "Schauenburgerstrasse", number: "17", plz: "4051" },
        geom: "POINT (2611234.567 1267890.123)"
      }
    ]);
  }

  if (pathname === "/stac/v1/collections") {
    return jsonResponse({
      collections: [
        {
          id: "STNA",
          title: "Strassennamen",
          description: "Strassen und Plätze in Basel-Stadt",
          keywords: ["Strasse"],
          links: []
        }
      ]
    });
  }
  if (pathname === "/stac/v1/collections/STNA") {
    return jsonResponse({
      id: "STNA",
      title: "Strassennamen",
      description: "Strassen und Plätze in Basel-Stadt",
      stac_version: "1.0.0",
      links: []
    });
  }
  if (pathname === "/stac/v1/collections/STNA/items") {
    return jsonResponse({
      features: [
        { id: "item-1", bbox: [0, 0, 1, 1], properties: { datetime: null }, assets: {}, links: [] }
      ]
    });
  }

  if (pathname === "/ogc/v1/wfs3/collections") {
    return jsonResponse({
      collections: [
        {
          id: STNA_COLLECTION_ID,
          title: "Strassennamen",
          crs: [CRS_2056]
        },
        {
          id: PARCEL_COLLECTION_ID,
          title: "Liegenschaft Basel-Stadt",
          crs: [CRS_2056]
        }
      ]
    });
  }
  if (pathname === `/ogc/v1/wfs3/collections/${STNA_COLLECTION_ID}`) {
    return jsonResponse({ id: STNA_COLLECTION_ID, title: "Strassennamen", crs: [CRS_2056] });
  }
  if (pathname === `/ogc/v1/wfs3/collections/${PARCEL_COLLECTION_ID}`) {
    return jsonResponse({ id: PARCEL_COLLECTION_ID, title: "Liegenschaft Basel-Stadt", crs: [CRS_2056] });
  }
  if (pathname === `/ogc/v1/wfs3/collections/${STNA_COLLECTION_ID}/items`) {
    return jsonResponse({
      features: [
        {
          type: "Feature",
          id: "feat-1",
          properties: { strasse: "Schauenburgerstrasse" }
        }
      ]
    });
  }
  if (pathname === `/ogc/v1/wfs3/collections/${PARCEL_COLLECTION_ID}/items`) {
    return jsonResponse({
      features: [
        {
          type: "Feature",
          id: "parcel-1",
          properties: { EGRID: "CH773573575017", Parzellennummer: "1017" }
        }
      ]
    });
  }

  if (pathname === "/grundstueckinfo/v1/realestatesinformation") {
    const ids = searchParams.get("ids");
    return jsonResponse({
      Date: "2026-08-28",
      RealEstates: [
        {
          EGRID: ids,
          Address: "Schauenburgerstrasse 17, 4051 Basel",
          LandCoverageInfo: [{ Type: "Gebäude", Area: 123 }]
        }
      ]
    });
  }

  return undefined;
}

async function connectClient() {
  const server = createGeoBsServer({ GEOBS_API_KEY: "test-key" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport)
  ]);
  return { client, server };
}

function textBlocks(result: CallToolResult): string[] {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text);
}

/**
 * A standards-conformant client that only reads `content` (never
 * `structuredContent`) must still be able to recover the full structured
 * result. This is exactly what a text-only client sees.
 */
function structuredContentFromText(result: CallToolResult): unknown {
  for (const text of textBlocks(result)) {
    try {
      return JSON.parse(text);
    } catch {
      // not every text block is JSON (e.g. the human-readable summary)
    }
  }
  return undefined;
}

// The schema is valid JSON Schema with prefixItems alone, but tool importers
// can require an explicit homogeneous items schema. Check what tools/list
// actually publishes, not just Zod's runtime validation.
function expectPortableArrays(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(expectPortableArrays);
    return;
  }
  const schema = value as Record<string, unknown>;
  expect(schema).not.toHaveProperty("prefixItems");
  if (schema.type === "array") {
    expect(schema.items).toBeTypeOf("object");
    expect(schema.items).not.toBeNull();
    expect(Array.isArray(schema.items)).toBe(false);
  }
  Object.values(schema).forEach(expectPortableArrays);
}

describe("MCP tool results are readable from `content` alone (client-neutral fix)", () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const response = routeFetch(url);
    if (!response) throw new Error(`Unmocked request: ${url.toString()}`);
    return response;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("search_location: content text alone contains reusable coordinates, matching structuredContent", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connectClient();
    try {
      const result = await client.callTool({
        name: "search_location",
        arguments: { query: "Schauenburgerstrasse 17" }
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeDefined();

      const fromText = structuredContentFromText(result);
      expect(fromText).toEqual(result.structuredContent);

      const results = (fromText as { results: Array<{ coordinate?: [number, number] }> }).results;
      expect(results[0]?.coordinate).toEqual([2611234.567, 1267890.123]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("get_property_info: a point copied from search_location's text resolves real estate info", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connectClient();
    try {
      const search = await client.callTool({
        name: "search_location",
        arguments: { query: "Schauenburgerstrasse 17" }
      });
      const searchData = structuredContentFromText(search) as {
        results: Array<{ coordinate: [number, number] }>;
      };
      const [x, y] = searchData.results[0]!.coordinate;

      const property = await client.callTool({
        name: "get_property_info",
        arguments: { point: { x, y, epsg: 2056 } }
      });

      expect(property.isError).toBeFalsy();
      const propertyFromText = structuredContentFromText(property);
      expect(propertyFromText).toEqual(property.structuredContent);
      expect(JSON.stringify(propertyFromText)).toContain("Schauenburgerstrasse");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("search_datasets -> get_dataset -> query_features: every result's content carries the full structured value", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connectClient();
    try {
      const datasets = await client.callTool({
        name: "search_datasets",
        arguments: { query: "Strassen" }
      });
      expect(structuredContentFromText(datasets)).toEqual(datasets.structuredContent);

      const dataset = await client.callTool({
        name: "get_dataset",
        arguments: { id: "STNA" }
      });
      expect(structuredContentFromText(dataset)).toEqual(dataset.structuredContent);
      const collectionId = (
        dataset.structuredContent as {
          ogcFeaturesDiscovery: { collections: Array<{ id: string }> };
        }
      ).ogcFeaturesDiscovery.collections[0]?.id;
      expect(collectionId).toBe(STNA_COLLECTION_ID);

      const features = await client.callTool({
        name: "query_features",
        arguments: { collectionId, bbox: [0, 0, 1, 1], limit: 5, includeGeometry: false }
      });
      expect(features.isError).toBeFalsy();
      expect(structuredContentFromText(features)).toEqual(features.structuredContent);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("discovers all five tool schemas and their read-only annotations", async () => {
    const { client, server } = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "search_location", "search_datasets", "get_dataset", "query_features", "get_property_info"
      ]);
      for (const tool of tools) {
        expectPortableArrays(tool.inputSchema);
        expectPortableArrays(tool.outputSchema);
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema?.type).toBe("object");
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false
        });
      }
      // Published schemas must retain their constraints, not only runtime validation.
      const inputs = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
      expect(inputs.get_dataset).toMatchObject({ properties: {
        id: { type: "string", pattern: "^[A-Za-z0-9._-]{1,100}$" }
      } });
      expect(inputs.query_features).toMatchObject({ properties: {
        bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
        collectionId: { pattern: "^[A-Za-z0-9._-]{1,300}$" },
        limit: { default: 10, minimum: 1, maximum: 25 },
        properties: { type: "array", maxItems: 30 },
        filters: { type: "array", maxItems: 5 }
      } });
      expect(inputs.get_property_info).toMatchObject({ properties: {
        ids: { minItems: 1, maxItems: 10, items: { pattern: "^[A-Za-z0-9-]{2,40}$" } }
      } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    [], [0, 0, 1], [0, 0, 1, 1, 2], [0, 0, 1, "1"], [0, 0, 1, null]
  ])("rejects malformed bbox %j before any upstream call", async (...bbox) => {
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connectClient();
    try {
      const result = await client.callTool({ name: "query_features", arguments: {
        collectionId: STNA_COLLECTION_ID, bbox
      } });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    {
      name: "search_location", arguments: { query: "Basel" },
      path: "/search/v2/search",
      body: [{ label: "Basel", layer_name: "Adresse", geom: "POINT (0 0)", details: { text: "x".repeat(130_000) } }]
    },
    {
      name: "search_datasets", arguments: { query: "Strassen" },
      path: "/stac/v1/collections",
      body: { collections: [{ id: "STNA", title: "Strassen", keywords: ["x".repeat(130_000)] }] }
    },
    {
      name: "get_dataset", arguments: { id: "STNA" },
      path: "/stac/v1/collections/STNA",
      body: { id: "STNA", assets: { bulk: { href: "https://api.geo.bs.ch/" + "x".repeat(130_000) } } }
    },
    {
      name: "query_features", arguments: { collectionId: STNA_COLLECTION_ID },
      path: `/ogc/v1/wfs3/collections/${STNA_COLLECTION_ID}/items`,
      body: { features: [{ type: "Feature", properties: { text: "x".repeat(130_000) } }] }
    },
    {
      name: "get_property_info", arguments: { ids: ["CH773573575017"] },
      path: "/grundstueckinfo/v1/realestatesinformation",
      body: { RealEstates: [{ text: "x".repeat(130_000) }] }
    }
  ])("$name returns a bounded MCP error for oversized data", async (testCase) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.pathname === testCase.path ? jsonResponse(testCase.body) : routeFetch(url)!;
    }));
    const { client, server } = await connectClient();
    try {
      const result = await client.callTool({ name: testCase.name, arguments: testCase.arguments });
      expect(result.isError).toBe(true);
      expect(structuredContentFromText(result)).toMatchObject({ error: "RESPONSE_TOO_LARGE" });
      expect(jsonByteLength(result)).toBeLessThanOrEqual(LIMITS.maxToolOutputBytes);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("query_features reports the reduced count in both JSON and its MCP summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `/ogc/v1/wfs3/collections/${STNA_COLLECTION_ID}/items`) {
        return jsonResponse({
          numberMatched: 3,
          features: Array.from({ length: 3 }, (_, id) => ({
            type: "Feature", id, properties: { text: "x".repeat(50_000) }
          }))
        });
      }
      return routeFetch(url)!;
    }));
    const { client, server } = await connectClient();
    try {
      const result = await client.callTool({ name: "query_features", arguments: { collectionId: STNA_COLLECTION_ID } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ numberReturned: 2, numberMatched: 3, outputTruncated: true });
      expect(structuredContentFromText(result)).toEqual(result.structuredContent);
      expect(textBlocks(result)[0]).toBe(`Returned 2 bounded feature(s) from ${STNA_COLLECTION_ID}.`);
      expect(jsonByteLength(result)).toBeLessThanOrEqual(LIMITS.maxToolOutputBytes);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
