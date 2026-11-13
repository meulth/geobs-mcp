import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { egridSchema, oerebPointSchema, oerebExtractUrl, OerebClient, type Json } from "../clients/oereb";
import { GeoBsError } from "../errors";
import { fitsToolOutput } from "../mcp/results";
import { registerReadOnlyTool } from "../mcp/register";
import { oerebChoices, type PropertyChoiceReader } from "./oerebChoices";
import { CANTONAL_SUPPLEMENT_NOTICE, OEREB_ANSWER_RULES } from "./oerebGuidance";

const inputShape = {
  egrid: egridSchema.optional(),
  point: oerebPointSchema.optional().describe("Exact LV95 point from search_api_v2 with epsg=2056. Provide either point or egrid.")
};
const inputSchema = z.object(inputShape);
const outputShape = {
  status: z.enum(["extract_available", "selection_required"]),
  resolvedFrom: z.record(z.string(), z.json()),
  candidates: z.array(z.record(z.string(), z.json())),
  choices: z.array(z.object({
    egrid: z.string(), propertyType: z.string().nullable(), section: z.string().nullable(),
    parcelNumber: z.string(), numberingArea: z.string(), label: z.string(),
    detailStatus: z.enum(["available", "unavailable"]), detailSource: z.record(z.string(), z.json()).nullable()
  })).optional(),
  egrid: z.string().optional(),
  response: z.record(z.string(), z.json()).optional(),
  source: z.object({ url: z.string(), retrievedAt: z.string() }),
  coverage: z.object({
    returnedJson: z.literal("complete_upstream_response"),
    cantonalSupplement: z.literal("not_verified_complete"),
    notice: z.string()
  }).optional(),
  guidance: z.string()
};

function summarize(output: { status: string; source: { url: string }; coverage?: { notice: string } }): string {
  return `${output.status === "selection_required" ? "Select a property before requesting an OEREB extract." : "Returned the complete JSON supplied by the OEREB service."} Source: ${output.source.url}${output.coverage ? ` ${output.coverage.notice}` : ""}`;
}

export async function getOerebExtract(client: OerebClient, input: unknown, choiceReader?: PropertyChoiceReader) {
  const parsed = inputSchema.parse(input);
  if (Boolean(parsed.egrid) === Boolean(parsed.point)) {
    throw new GeoBsError("INVALID_INPUT", "Provide exactly one of egrid or an EPSG:2056 point.");
  }
  let egrid = parsed.egrid?.toUpperCase();
  let candidates: Array<Record<string, Json>> = [];
  const resolvedFrom: Record<string, Json> = parsed.point
    ? { type: "point", point: parsed.point } : { type: "egrid" };
  if (parsed.point) {
    const lookup = await client.findEgrids(parsed.point);
    candidates = lookup.candidates;
    resolvedFrom.lookupSource = { url: lookup.url, retrievedAt: new Date().toISOString() };
    const egrids = [...new Set(lookup.candidates.map(candidate => candidate.egrid.toUpperCase()))];
    // Candidate order is not a relevance ranking. Duplicate IDs are not a choice.
    if (egrids.length > 1) {
      const choices = await oerebChoices(lookup.candidates, parsed.point, choiceReader);
      const output = {
        status: "selection_required" as const, resolvedFrom, candidates, choices,
        source: { url: lookup.url, retrievedAt: new Date().toISOString() },
        guidance: "Multiple different E-GRIDs were returned. Ask which property/property form the user means. Show each choices label (full property type, section, parcel number) and E-GRID; include numberingArea for context. Never filter to Liegenschaft only or silently prefer it over Baurecht/Unterbaurecht. Use exact OGC detail labels only when detailStatus=available; otherwise disclose unavailable detail and keep the original OEREB type, which may not distinguish Baurecht from Unterbaurecht. Then call get_oereb_extract with the selected exact egrid. Order is not a relevance ranking. No extract has been fetched. The point lookup is not verified exact containment; the OEREB specification permits a one-metre capture radius."
      };
      if (!fitsToolOutput(output, summarize(output))) {
        throw new GeoBsError("RESPONSE_TOO_LARGE", `The full property choice exceeds the MCP output limit; no candidates were silently removed. Official lookup: ${lookup.url}`);
      }
      return output;
    }
    egrid = egrids[0]!;
  }
  const url = oerebExtractUrl(egrid!, "json").href;
  try {
    const response = await client.getExtract(egrid!);
    const output = {
      status: "extract_available" as const, resolvedFrom, candidates, egrid: egrid!, response,
      source: { url, retrievedAt: new Date().toISOString() },
      coverage: { returnedJson: "complete_upstream_response" as const,
        cantonalSupplement: "not_verified_complete" as const, notice: CANTONAL_SUPPLEMENT_NOTICE },
      guidance: OEREB_ANSWER_RULES + " Cite the exact E-GRID, source and returned legal notices/status. A point-based lookup is a candidate lookup, not verified exact containment; the OEREB specification permits a one-metre capture radius. CreationDate is extract creation, UpdateDateCS concerns cadastral surveying, neither is the update date of all restrictions. Preserve dates without guessing a timezone. This is not a complete legal dossier or permission to build."
    };
    if (!fitsToolOutput(output, summarize(output))) {
      throw new GeoBsError("RESPONSE_TOO_LARGE", "The complete OEREB extract exceeds the MCP output limit.");
    }
    return output;
  } catch (error) {
    if (error instanceof GeoBsError && error.code === "RESPONSE_TOO_LARGE") {
      throw new GeoBsError("RESPONSE_TOO_LARGE", `The complete OEREB extract could not be returned within the safety limits; no fields were silently removed. Retrieve the official JSON: ${url}`);
    }
    throw error;
  }
}

export function registerGetOerebExtract(server: McpServer, client: OerebClient, choiceReader?: PropertyChoiceReader) {
  registerReadOnlyTool(server, {
    name: "get_oereb_extract",
    title: "Get a Basel-Stadt OEREB JSON extract",
    description: "Get public-law restrictions for one E-GRID, or resolve an exact EPSG:2056 point through the key-free OEREB API first. Resolve addresses with search_api_v2 (epsg=2056); clarify ambiguous places. Provide exactly one of egrid or point. Multiple properties require user selection, never silently choose the first. Always requests extended=true. Returns the full supplied JSON with notices and dates, without an unsolicited PDF link. " + OEREB_ANSWER_RULES,
    inputSchema: inputShape, outputSchema: outputShape,
    example: { egrid: "CH516702897010" },
    execute: input => getOerebExtract(client, input, choiceReader), summarize
  });
}
