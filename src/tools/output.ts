import { LIMITS } from "../config";

export function compactText(value: string | undefined, max = 600): string | undefined {
  if (!value) return value;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function selectLinks(
  links: Array<{ href: string; rel: string; type?: string; title?: string }> | undefined
) {
  return (links ?? [])
    .filter((link) => ["self", "items", "related", "describedby"].includes(link.rel))
    .slice(0, 20)
    .map(({ href, rel, type, title }) => ({ href, rel, type, title }));
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

// Every MCP tool result also serializes its structured value into a
// TextContent block (see successResult in mcp/server.ts) so clients that
// only read `content`, not `structuredContent`, still see the full result.
// That duplication roughly doubles the wire size of a result, so output
// budgets must be checked against this estimate, not the bare value.
export function mcpResultByteLength(value: unknown): number {
  return jsonByteLength({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value
  });
}

export function enforceFeatureOutputLimit<T extends { features: Array<Record<string, unknown>> }>(
  value: T
): T & { geometryOmitted?: boolean; outputTruncated?: boolean } {
  if (mcpResultByteLength(value) <= LIMITS.maxToolOutputBytes) return value;

  const withoutGeometry = {
    ...value,
    geometryOmitted: true,
    features: value.features.map(({ geometry: _geometry, ...feature }) => feature)
  };
  if (mcpResultByteLength(withoutGeometry) <= LIMITS.maxToolOutputBytes) return withoutGeometry;

  while (
    withoutGeometry.features.length > 1 &&
    mcpResultByteLength(withoutGeometry) > LIMITS.maxToolOutputBytes
  ) {
    withoutGeometry.features.pop();
  }
  return { ...withoutGeometry, outputTruncated: true };
}
