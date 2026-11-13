import { describe, expect, it, vi } from "vitest";
import { oerebChoices, type PropertyChoiceReader } from "../../src/tools/oerebChoices";
import { OerebClient } from "../../src/clients/oereb";
import { getOerebExtract } from "../../src/tools/getOerebExtract";

const point = { x: 2610862.48, y: 1267895.68, epsg: 2056 as const };
// Public screenshot case, represented as synthetic fixture responses.
const candidates = [
  { egrid: "CH555889776758", number: "0479", identDN: "BSS100000000", type: { Code: "RealEstate" } },
  { egrid: "CH467289678830", number: "2596", identDN: "BSS100000000", type: { Code: "Distinct_and_permanent_rights.BuildingRight" } },
  { egrid: "CH876772948919", number: "2763", identDN: "BSS100000000", type: { Code: "Distinct_and_permanent_rights.BuildingRight" } }
];
const titles = ["Amtliche Vermessung Parzellen - Liegenschaft", "Amtliche Vermessung Parzellen - Selbstrecht"];
const features = [
  { properties: { EGRID: candidates[0]!.egrid, "Grundstücksart": "Liegenschaft.Liegenschaft", Sektionsname: "1", Parzellennummer: "0479" } },
  { properties: { EGRID: candidates[1]!.egrid, "Grundstücksart": "SelbstRecht.Baurecht.Baurecht", Sektionsname: "1", Parzellennummer: "2596" } },
  { properties: { EGRID: candidates[2]!.egrid, "Grundstücksart": "SelbstRecht.Baurecht.UnterBaurecht", Sektionsname: "1", Parzellennummer: "2763" } },
  { properties: { EGRID: "CH446789729910", "Grundstücksart": "SelbstRecht.weitere.andere_Dienstbarkeit", Sektionsname: "1", Parzellennummer: "2597" } }
];
function reader(rows = features) {
  return {
    listCollections: vi.fn(async () => titles.map((title, index) => ({ id: `discovered-${index}`, title }))),
    queryFeatures: vi.fn(async () => ({ collection: { id: "discovered" }, outputEpsg: 2056,
      featureCollection: { features: rows },
      evidence: { url: "https://api.geo.bs.ch/ogc/v1/wfs3/collections/discovered/items?bbox=example", retrievedAt: "2026-11-13T02:00:00Z" }
    }))
  } as unknown as PropertyChoiceReader;
}

describe("OEREB property form choices", () => {
  it("reproduces all three screenshot forms by E-GRID without adding unrelated OGC matches", async () => {
    const source = reader();
    const choices = await oerebChoices(candidates, point, source);
    expect(choices).toHaveLength(3);
    expect(choices.map(choice => choice.label)).toEqual([
      "Liegenschaft.Liegenschaft – Sektion 1, Parzelle 0479",
      "SelbstRecht.Baurecht.Baurecht – Sektion 1, Parzelle 2596",
      "SelbstRecht.Baurecht.UnterBaurecht – Sektion 1, Parzelle 2763"
    ]);
    expect(choices.every(choice => choice.detailStatus === "available")).toBe(true);
    expect(choices[2]?.detailSource).toHaveProperty("collectionId");
    expect(source.queryFeatures).toHaveBeenCalledWith("discovered-0", expect.objectContaining({ limit: 25, bboxEpsg: 2056 }));
  });
  it("never infers Unterbaurecht from the generic OEREB BuildingRight code", async () => {
    const source = reader(); vi.mocked(source.listCollections).mockRejectedValue(new Error("unavailable"));
    const choices = await oerebChoices(candidates, point, source);
    expect(choices).toHaveLength(3);
    expect(choices[2]).toMatchObject({ detailStatus: "unavailable", section: null, detailSource: null,
      propertyType: "Distinct_and_permanent_rights.BuildingRight" });
    expect(choices[2]?.label).not.toContain("UnterBaurecht");
  });
  it("does not discard choices when one detail layer fails", async () => {
    const source = reader(); vi.mocked(source.queryFeatures).mockRejectedValueOnce(new Error("failure"));
    expect(await oerebChoices(candidates, point, source)).toHaveLength(3);
  });
  it("refuses conflicting detail labels or a mismatched parcel number", async () => {
    const rows = [...features, { properties: { ...features[2]!.properties, "Grundstücksart": "conflicting" } }];
    expect((await oerebChoices(candidates, point, reader(rows)))[2]?.detailStatus).toBe("unavailable");
    const wrong = features.map(feature => ({ properties: { ...feature.properties, Parzellennummer: "9999" } }));
    expect((await oerebChoices(candidates, point, reader(wrong))).every(choice => choice.detailStatus === "unavailable")).toBe(true);
  });
  it("does not pick between several catalog layers for the same role", async () => {
    const source = reader();
    vi.mocked(source.listCollections).mockResolvedValue([
      { id: "a", title: titles[0] }, { id: "b", title: titles[0] }
    ]);
    expect((await oerebChoices(candidates, point, source))[0]?.detailStatus).toBe("unavailable");
    expect(source.queryFeatures).not.toHaveBeenCalled();
  });
  it("only enriches multi-property choices and directly fetches a single match", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes("getegrid")
      ? { GetEGRIDResponse: [candidates[0]] }
      : { GetExtractByIdResponse: { extract: { RealEstate: { EGRID: candidates[0]!.egrid } } } }));
    const source = reader();
    expect(await getOerebExtract(new OerebClient(fetcher), { point }, source)).toMatchObject({ status: "extract_available" });
    expect(source.listCollections).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("returns detailed choices without fetching an extract when there are several IDs", async () => {
    const fetcher = vi.fn(async () => Response.json({ GetEGRIDResponse: candidates }));
    const output = await getOerebExtract(new OerebClient(fetcher), { point }, reader());
    expect(output).toMatchObject({ status: "selection_required", choices: [{ label: expect.stringContaining("0479") },
      { label: expect.stringContaining("2596") }, { label: expect.stringContaining("2763") }] });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(output).not.toHaveProperty("response");
  });
});
