import { describe, expect, it, vi } from "vitest";
import { PropertyInfoClient } from "../../src/clients/propertyInfo";

describe("PropertyInfoClient", () => {
  it("requires the server-side secret", async () => {
    const fetcher = vi.fn();
    await expect(
      new PropertyInfoClient(undefined, fetcher).getInformation(["CH776779888908"])
    ).rejects.toMatchObject({ code: "MISSING_API_KEY" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps real estate information and never puts the key in the URL", async () => {
    const fixture = {
      Date: "28.08.2026 02:21:54",
      RealEstates: [{ Egrid: "CH776779888908", Buildings: [], Landcovers: [] }]
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(fixture)
    );
    const result = await new PropertyInfoClient("private-key", fetcher).getInformation([
      "CH776779888908"
    ]);
    const [input, init] = fetcher.mock.calls[0]!;
    expect(String(input)).not.toContain("private-key");
    expect((init?.headers as Record<string, string>).apikey).toBe("private-key");
    expect(result.RealEstates?.[0]?.Egrid).toBe("CH776779888908");
  });

  it("rejects unsafe identifiers", async () => {
    const fetcher = vi.fn();
    await expect(
      new PropertyInfoClient("key", fetcher).getInformation(["x&ids=other"])
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
