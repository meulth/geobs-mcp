import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { egridSchema, oerebExtractUrl } from "../clients/oereb";
import { registerReadOnlyTool } from "../mcp/register";

const inputShape = { egrid: egridSchema };
const inputSchema = z.object(inputShape);
const outputShape = {
  status: z.literal("link_available"), egrid: z.string(), pdfUrl: z.string(),
  downloaded: z.literal(false), egridVerified: z.literal(false), guidance: z.string()
};

export async function getOerebPdfLink(input: unknown) {
  const { egrid } = inputSchema.parse(input);
  return {
    status: "link_available" as const, egrid: egrid.toUpperCase(),
    pdfUrl: oerebExtractUrl(egrid, "pdf").href,
    downloaded: false as const, egridVerified: false as const,
    guidance: "Official OEREB PDF download URL with extended=true, provided on explicit PDF request. Opening it asks the official service to generate the extract including Annex A. Generation can take tens of seconds and varies. The MCP server has not downloaded or inspected a PDF or verified this E-GRID exists. Use an E-GRID confirmed by the JSON extract or property lookup. Cite the official source and retain its legal notices; no additional legal effect is inferred from PDF format."
  };
}

export function registerGetOerebPdfLink(server: McpServer) {
  registerReadOnlyTool(server, {
    name: "get_oereb_pdf_link", title: "Get the official extended OEREB PDF link",
    description: "Only when the user explicitly asks for a PDF: provide the official Basel-Stadt OEREB download link for a known E-GRID, always with extended=true. Resolve a missing E-GRID first using get_oereb_extract or property information. Does not generate, download, attach, validate or cache a PDF; the official service generates it when the user opens the link. A valid E-GRID format alone does not prove the property exists.",
    inputSchema: inputShape, outputSchema: outputShape,
    example: { egrid: "CH516702897010" }, execute: getOerebPdfLink,
    summarize: output => `Official PDF download link (not downloaded): ${output.pdfUrl}`
  });
}
