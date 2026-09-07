import { AsyncLocalStorage } from "node:async_hooks";
import type { GeoBsErrorCode } from "./errors";

type Outcome = "success" | "error";
type Event = {
  duration_ms: number;
  outcome: Outcome;
  error_code?: GeoBsErrorCode;
} & (
  | { event: "http_request"; route: "mcp" | "health" | "other"; method: string; status: number }
  | { event: "mcp_tool"; tool: string; output_bytes?: number }
  | { event: "geobs_upstream"; upstream: string; status?: number; response_bytes?: number }
);

// Only the context carrier is shared. Each request gets its own immutable ID.
const context = new AsyncLocalStorage<{ request_id: string }>();

export function withTelemetry<T>(callback: () => T): T {
  return context.run({ request_id: crypto.randomUUID() }, callback);
}

export function elapsed(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 100) / 100);
}

export function recordEvent(event: Event): void {
  const request = context.getStore();
  if (!request) return;
  try {
    console.log({
      service: "geobs-mcp",
      schema_version: 1,
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...request,
      ...event
    });
  } catch {
    // Observability must not change the MCP result or service availability.
  }
}

export async function observeHttp(request: Request, handler: () => Promise<Response>): Promise<Response> {
  return withTelemetry(async () => {
    const start = performance.now();
    const path = new URL(request.url).pathname;
    const route = path === "/mcp" ? "mcp" : path === "/" ? "health" : "other";
    const method = ["GET", "POST", "DELETE", "OPTIONS", "HEAD", "PUT", "PATCH"].includes(request.method)
      ? request.method : "OTHER";
    let status = 500;
    try {
      const response = await handler();
      status = response.status;
      return response;
    } finally {
      recordEvent({ event: "http_request", route, method, status,
        outcome: status < 400 ? "success" : "error", duration_ms: elapsed(start) });
    }
  });
}

export function upstreamName(path: string): string {
  if (path.startsWith("/search/v2/")) return "search";
  if (path.startsWith("/stac/v1/")) return "stac";
  if (path.startsWith("/ogc/v1/wfs3/")) return "ogc_features";
  if (path.startsWith("/grundstueckinfo/v1/")) return "property_info";
  return "other";
}
