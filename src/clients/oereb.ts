import { z } from "zod";
import { OEREB_ORIGIN } from "../config";
import { GeoBsError } from "../errors";
import { fetchJson, type FetchLike } from "../http";

export type Json = z.infer<ReturnType<typeof z.json>>;

export const egridSchema = z.string().trim().regex(/^CH[0-9]{12}$/i)
  .describe("Swiss E-GRID: CH followed by exactly twelve digits.");
export const oerebPointSchema = z.object({
  x: z.number().finite().min(2_000_000).max(3_000_000),
  y: z.number().finite().min(1_000_000).max(2_000_000),
  epsg: z.literal(2056)
});

const candidateSchema = z.object({
  egrid: egridSchema,
  number: z.string(),
  identDN: z.string(),
  type: z.record(z.string(), z.json()).optional()
}).catchall(z.json());
const candidatesSchema = z.object({ GetEGRIDResponse: z.array(candidateSchema) });
const extractSchema = z.object({
  GetExtractByIdResponse: z.object({
    extract: z.object({ RealEstate: z.object({ EGRID: egridSchema }) })
  })
});
export type EgridCandidate = z.infer<typeof candidateSchema>;

export function oerebExtractUrl(egrid: string, format: "json" | "pdf"): URL {
  const normalized = egridSchema.parse(egrid).toUpperCase();
  const url = new URL(`/extract/${format}/`, OEREB_ORIGIN);
  url.searchParams.set("EGRID", normalized);
  url.searchParams.set("extended", "true");
  return url;
}

export class OerebClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async findEgrids(point: z.infer<typeof oerebPointSchema>) {
    const parsed = oerebPointSchema.parse(point);
    const url = new URL("/getegrid/json/", OEREB_ORIGIN);
    url.searchParams.set("EN", `${parsed.x},${parsed.y}`);
    const response = await fetchJson<unknown>(url, {
      service: "oereb", fetcher: this.fetcher, notFoundCode: "NO_RESULTS"
    });
    const result = candidatesSchema.safeParse(response.data);
    if (!result.success) {
      throw new GeoBsError("INVALID_UPSTREAM_RESPONSE", "The OEREB E-GRID response has an unexpected structure.");
    }
    if (result.data.GetEGRIDResponse.length === 0) {
      throw new GeoBsError("NO_RESULTS", "No E-GRID was found at the supplied point; this does not prove that no property exists.");
    }
    return { candidates: result.data.GetEGRIDResponse, url: url.href };
  }

  async getExtract(egrid: string): Promise<Record<string, Json>> {
    const normalized = egridSchema.parse(egrid).toUpperCase();
    const response = await fetchJson<unknown>(oerebExtractUrl(normalized, "json"), {
      service: "oereb", fetcher: this.fetcher, notFoundCode: "NO_RESULTS"
    });
    const result = extractSchema.safeParse(response.data);
    if (!result.success || result.data.GetExtractByIdResponse.extract.RealEstate.EGRID.toUpperCase() !== normalized) {
      throw new GeoBsError("INVALID_UPSTREAM_RESPONSE", "The OEREB extract is invalid or belongs to a different E-GRID.");
    }
    // Validate required structure without parsing away unknown root/extension fields.
    return response.data as Record<string, Json>;
  }
}
