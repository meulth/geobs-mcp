import { describe, expect, it, vi } from "vitest";
import { StacClient } from "../../src/clients/stac";

describe("StacClient", () => {
  it("reads live-shaped collection metadata", async () => {
    const fixture = {
      id: "STNA",
      title: "Strassennamen",
      description: "Strassen und Plätze",
      keywords: ["Strasse"],
      links: []
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(fixture)
    );
    const result = await new StacClient(fetcher).getCollection("STNA");
    expect(result).toEqual(fixture);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "https://api.geo.bs.ch/stac/v1/collections/STNA"
    );
  });

  it("validates dataset IDs before constructing URLs", async () => {
    const fetcher = vi.fn();
    await expect(new StacClient(fetcher).getCollection("https://evil.test"))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps a missing dataset", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(new StacClient(fetcher).getCollection("NONE"))
      .rejects.toMatchObject({ code: "DATASET_NOT_FOUND" });
  });

  it.each([
    [0, 0], [1, 1], [10, 10]
  ])("recognizes a complete page with %i items and a known total", async (received, total) => {
    const fetcher = vi.fn(async () => Response.json({
      features: Array.from({ length: received }, (_, id) => ({ id: String(id) })),
      numberMatched: total, numberReturned: received, links: []
    }));
    const page = await new StacClient(fetcher).listItemsPage("STNA");
    expect(page.coverage).toMatchObject({ complete: true, reasons: [], numberReturned: received,
      numberMatched: total, requestedLimit: 10, hasNextPage: false });
    expect(page.source.url).toBe("https://api.geo.bs.ch/stac/v1/collections/STNA/items?limit=10");
    expect(Number.isFinite(Date.parse(page.source.retrievedAt))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}, "unknown_total"],
    [{ numberMatched: 12 }, "upstream_limit"],
    [{ numberMatched: 2, links: [{ rel: "next", href: "https://evil.example/next" }] }, "next_page"],
    [{ numberMatched: 1 }, "inconsistent_counts"],
    [{ numberMatched: 2, numberReturned: 1 }, "inconsistent_counts"],
    [{ numberMatched: "2" }, "inconsistent_counts"],
    [{ numberMatched: -1 }, "inconsistent_counts"]
  ])("does not claim completeness with page metadata %j", async (metadata, reason) => {
    const fetcher = vi.fn(async () => Response.json({ features: [{ id: "a" }, { id: "b" }], ...metadata }));
    const page = await new StacClient(fetcher).listItemsPage("STNA");
    expect(page.coverage.complete).toBe(false);
    expect(page.coverage.reasons).toContain(reason);
    expect(fetcher).toHaveBeenCalledTimes(1); // No automatic pagination, including foreign next links.
  });

  it("bounds an oversized upstream page and retains the existing array API", async () => {
    const fetcher = vi.fn(async () => Response.json({
      features: Array.from({ length: 11 }, (_, id) => ({ id: String(id) })), numberMatched: 11
    }));
    const client = new StacClient(fetcher);
    const page = await client.listItemsPage("STNA", 500);
    expect(page.items).toHaveLength(10);
    expect(page.coverage).toMatchObject({ complete: false, requestedLimit: 10 });
    expect(page.coverage.reasons).toContain("local_limit");
    expect(await client.listItems("STNA", 1)).toHaveLength(1);
  });
});
