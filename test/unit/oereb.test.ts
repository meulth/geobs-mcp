import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { OerebClient, oerebExtractUrl } from "../../src/clients/oereb";
import { getOerebExtract } from "../../src/tools/getOerebExtract";
import { getOerebPdfLink } from "../../src/tools/getOerebPdfLink";
import { fetchJson } from "../../src/http";
import { createGeoBsServer } from "../../src/mcp/server";
import { withTelemetry } from "../../src/telemetry";

const EGRID = "CH516702897010";
const OTHER = "CH187289677283";
const point = { x: 2613004, y: 1269174.9, epsg: 2056 as const };
const candidate = (egrid = EGRID, identDN = "BSS500000000") => ({
  egrid, number: "0039", identDN, type: { Code: "RealEstate", Text: [{ Language: "de", Text: "Liegenschaft" }] }
});
const extract = (egrid = EGRID) => ({
  extensionAtRoot: { arbitrary: ["preserved"] },
  GetExtractByIdResponse: { extract: {
    CreationDate: "2026-11-13T01:00:00", UpdateDateCS: "2026-11-12T00:00:00",
    ExtractIdentifier: "synthetic-extract", RealEstate: { EGRID: egrid,
      RestrictionOnLandownership: [{ Theme: { Code: "synthetic" }, Lawstatus: { Code: "inForce" },
        LegalProvisions: [{ TextAtWeb: "https://example.test/law" }], extension: { keep: true } }],
      futurePropertyExtension: [1, 2, 3] },
    ConcernedTheme: [{ Code: "synthetic" }], NotConcernedTheme: [], ThemeWithoutData: [],
    Disclaimer: [{ Content: "synthetic legal notice" }], futureExtractExtension: { keep: "all" }
  } }
});
const setup = (data = extract()) => {
  const fetcher = vi.fn(async () => Response.json(data));
  return { fetcher, client: new OerebClient(fetcher) };
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("OEREB inputs, sources and selection", () => {
  it("preserves the entire extract and unknown fields with only extended=true", async () => {
    const { client, fetcher } = setup();
    const output = await getOerebExtract(client, { egrid: ` ${EGRID.toLowerCase()} ` });
    expect(output).toMatchObject({ status: "extract_available", egrid: EGRID, response: extract(), candidates: [] });
    expect(output.source.url).toBe(`https://api.oereb.bs.ch/extract/json/?EGRID=${EGRID}&extended=true`);
    expect(output).toHaveProperty("pdfUrl", `https://api.oereb.bs.ch/extract/pdf/?EGRID=${EGRID}&extended=true`);
    const [url, options] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.href).toBe(output.source.url);
    expect(options.redirect).toBe("manual");
    expect(Object.keys(options.headers!)).toEqual(["accept"]);
    expect(output.guidance).toContain("UpdateDateCS");
  });

  it("resolves the exact LV95 point then requests its returned E-GRID", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return Response.json(url.pathname.startsWith("/getegrid") ? { GetEGRIDResponse: [candidate(OTHER)] } : extract(OTHER));
    });
    const result = await getOerebExtract(new OerebClient(fetcher), { point });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("EN")).toBe("2613004,1269174.9");
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get("EGRID")).toBe(OTHER);
    expect(result).toMatchObject({ egrid: OTHER, resolvedFrom: { type: "point", point }, candidates: [candidate(OTHER)] });
  });

  it.each([false, true])("returns all distinct choices without fetching extracts (reverse=%s)", async reverse => {
    const rows = [candidate(), { ...candidate(OTHER, "BSS700000000"), type: { Code: "Distinct_and_permanent_rights" } }];
    if (reverse) rows.reverse();
    const fetcher = vi.fn(async () => Response.json({ GetEGRIDResponse: rows }));
    const client = new OerebClient(fetcher);
    const result = await getOerebExtract(client, { point });
    expect(result).toMatchObject({ status: "selection_required", candidates: rows });
    expect(result).not.toHaveProperty("response");
    expect(result).not.toHaveProperty("egrid");
    expect(result.guidance).toContain("not a relevance ranking");
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockImplementation(async () => Response.json(extract(OTHER)));
    const selected = await getOerebExtract(client, { egrid: OTHER });
    expect(selected).toMatchObject({ status: "extract_available", egrid: OTHER });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not ask to choose between duplicate records for the same E-GRID", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(
      String(input).includes("getegrid") ? { GetEGRIDResponse: [candidate(), candidate()] } : extract()
    ));
    expect(await getOerebExtract(new OerebClient(fetcher), { point })).toMatchObject({ status: "extract_available", egrid: EGRID });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { egrid: EGRID, point }, { egrid: "INVALID" }, { egrid: `${EGRID}&extended=false` },
    { point: { ...point, epsg: 4326 } }, { point: { ...point, x: point.y, y: point.x } },
    { point: { ...point, x: NaN } }, { point: { ...point, y: Infinity } }])("rejects malformed input before HTTP: %j", async input => {
    const { client, fetcher } = setup();
    await expect(getOerebExtract(client, input)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not silently shorten an oversized extract", async () => {
    const data = { ...extract(), extra: "x".repeat(140_000) };
    const fetcher = vi.fn(async () => Response.json(data));
    await expect(getOerebExtract(new OerebClient(fetcher), { egrid: EGRID })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE", message: expect.stringContaining(`EGRID=${EGRID}&extended=true`)
    });
  });

  it("does not silently truncate a large list of choices", async () => {
    const fetcher = vi.fn(async () => Response.json({ GetEGRIDResponse: [
      { ...candidate(), extra: "x".repeat(140_000) }, candidate(OTHER)
    ] }));
    await expect(getOerebExtract(new OerebClient(fetcher), { point })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE", message: expect.stringContaining("Official lookup:")
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("returns a PDF link without fetching, generating, caching or verifying a file", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await getOerebPdfLink({ egrid: EGRID.toLowerCase() })).toMatchObject({
      status: "link_available", egrid: EGRID, downloaded: false, egridVerified: false,
      pdfUrl: `https://api.oereb.bs.ch/extract/pdf/?EGRID=${EGRID}&extended=true`
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(getOerebPdfLink({ egrid: "INVALID" })).rejects.toThrow();
    for (const format of ["json", "pdf"] as const) {
      expect([...oerebExtractUrl(EGRID, format).searchParams]).toEqual([["EGRID", EGRID], ["extended", "true"]]);
    }
  });
});

describe("OEREB transport and failure boundaries", () => {
  it.each([204, 404])("maps no-result HTTP %s without parsing JSON", async status => {
    const fetcher = vi.fn(async () => new Response(null, { status }));
    const client = new OerebClient(fetcher);
    await expect(client.findEgrids(point)).rejects.toMatchObject({ code: "NO_RESULTS" });
    await expect(client.getExtract(EGRID)).rejects.toMatchObject({ code: "NO_RESULTS" });
  });
  it.each([
    [400, "UPSTREAM_REJECTED"], [429, "RATE_LIMIT"], [503, "UPSTREAM_UNAVAILABLE"],
    [403, "UPSTREAM_AUTH_ERROR"], [302, "UPSTREAM_REJECTED"]
  ])("maps HTTP %s safely", async (status, code) => {
    const fetcher = vi.fn(async () => new Response("private raw HTML detail", { status: Number(status) }));
    await expect(new OerebClient(fetcher).getExtract(EGRID)).rejects.toMatchObject({ code });
    try { await new OerebClient(fetcher).getExtract(EGRID); } catch (error) {
      expect(String(error)).not.toContain("private raw HTML");
      expect(String(error)).not.toContain("API key");
    }
  });
  it.each([{}, { GetEGRIDResponse: {} }, { GetEGRIDResponse: [{ egrid: EGRID }] }])("rejects invalid lookup structure %j", async data => {
    const fetcher = vi.fn(async () => Response.json(data));
    await expect(new OerebClient(fetcher).findEgrids(point)).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });
  it("maps an empty candidate list to no results", async () => {
    const fetcher = vi.fn(async () => Response.json({ GetEGRIDResponse: [] }));
    await expect(new OerebClient(fetcher).findEgrids(point)).rejects.toMatchObject({ code: "NO_RESULTS" });
  });
  it.each([{}, extract(OTHER)])("rejects a malformed or mismatched extract", async data => {
    const fetcher = vi.fn(async () => Response.json(data));
    await expect(new OerebClient(fetcher).getExtract(EGRID)).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });
  it("rejects incorrect content types, bad JSON, oversized bodies and network failures", async () => {
    for (const response of [new Response("<html>"), new Response("broken", { headers: { "content-type": "application/json" } })]) {
      await expect(new OerebClient(async () => response).getExtract(EGRID)).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    }
    await expect(new OerebClient(async () => Response.json({ large: "x".repeat(2_000_001) })).getExtract(EGRID))
      .rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    await expect(new OerebClient(async () => { throw new Error("private detail"); }).getExtract(EGRID))
      .rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
  it("keeps the original host boundary and rejects foreign hosts, URL credentials and custom OEREB headers", async () => {
    const fetcher = vi.fn();
    const url = oerebExtractUrl(EGRID, "json");
    await expect(fetchJson(url, { fetcher })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const input of ["https://api.geo.bs.ch/extract/json/", "https://api.oereb.bs.ch.evil.test/extract/json/", "http://api.oereb.bs.ch/extract/json/", "https://user:pass@api.oereb.bs.ch/extract/json/"]) {
      await expect(fetchJson(input, { service: "oereb", fetcher })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(fetchJson(url, { service: "oereb", fetcher, headers: { apikey: "private" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("aborts body reads and logs only the OEREB category, not property data", async () => {
    const events: Record<string, unknown>[] = [];
    await withTelemetry(async () => {
      await expect(fetchJson(oerebExtractUrl(EGRID, "json"), {
        service: "oereb", timeoutMs: 5,
        fetcher: async (_, init) => new Response(new ReadableStream({ start(controller) {
          init!.signal!.addEventListener("abort", () => controller.error(new Error("private detail")), { once: true });
        } }), { headers: { "content-type": "application/json" } })
      })).rejects.toMatchObject({ code: "TIMEOUT" });
    }, event => events.push(event));
    expect(events).toMatchObject([{ upstream: "oereb", error_code: "TIMEOUT" }]);
    expect(JSON.stringify(events)).not.toContain(EGRID);
    expect(JSON.stringify(events)).not.toContain("private detail");
  });
});

describe("OEREB through the actual MCP SDK", () => {
  it("preserves text/structured compatibility without forwarding the configured GeoBS key", async () => {
    const fetcher = vi.fn(async () => Response.json(extract())); vi.stubGlobal("fetch", fetcher);
    const server = createGeoBsServer({ GEOBS_API_KEY: "private-geobs-key" });
    const client = new Client({ name: "oereb-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    try {
      const result = await client.callTool({ name: "get_oereb_extract", arguments: { egrid: EGRID } });
      expect(result.isError).not.toBe(true);
      const texts = result.content.filter((part: any) => part.type === "text") as Array<{ text: string }>;
      expect(JSON.parse(texts[1]!.text)).toEqual(result.structuredContent);
      expect(result.structuredContent).toMatchObject({ response: extract() });
      expect(JSON.stringify(fetcher.mock.calls)).not.toContain("private-geobs-key");
      const pdf = await client.callTool({ name: "get_oereb_pdf_link", arguments: { egrid: EGRID } });
      expect(pdf.isError).not.toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
      const invalid = await client.callTool({ name: "get_oereb_extract", arguments: { egrid: EGRID, point } });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid.content)).toContain("INVALID_INPUT");
    } finally { await client.close(); await server.close(); }
  });
});
