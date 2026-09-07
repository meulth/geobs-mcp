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
});
