import { describe, expect, it, vi } from "vitest";
import { SearchClient, parsePointWkt } from "../../src/clients/search";

describe("SearchClient", () => {
  it("requires GEOBS_API_KEY before making a request", async () => {
    const fetcher = vi.fn();
    await expect(new SearchClient(undefined, fetcher).search("Dufourstrasse 40"))
      .rejects.toMatchObject({ code: "MISSING_API_KEY" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the key only as a header and maps the actual response shape", async () => {
    const fixture = [
      {
        label: "Dufourstrasse 40, 4052 Basel ",
        layer_name: "Adresse",
        details: { street: "Dufourstrasse", number: "40" },
        geom: "POINT (2611776.302 1266865.109)"
      }
    ];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(fixture)
    );
    const results = await new SearchClient("test-secret", fetcher).search(
      "Dufourstrasse 40",
      { limit: 5, epsg: 2056 }
    );
    const [input, init] = fetcher.mock.calls[0]!;
    expect(String(input)).not.toContain("test-secret");
    expect((init?.headers as Record<string, string>).apikey).toBe("test-secret");
    expect(results).toEqual(fixture);
    expect(parsePointWkt(results[0]!.geom)).toEqual([2611776.302, 1266865.109]);
  });

  it("rejects an invalid external response", async () => {
    const fetcher = vi.fn(async () => Response.json({ results: [] }));
    await expect(new SearchClient("key", fetcher).search("Basel"))
      .rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });
});
