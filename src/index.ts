import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./config";
import { createGeoBsServer } from "./mcp/server";

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse({
        name: "geobs-mcp",
        version: "0.1.0",
        status: "ok",
        mcp: "/mcp",
        authentication: "none"
      });
    }
    if (url.pathname !== "/mcp") {
      return jsonResponse({ error: "not_found" }, 404);
    }

    const handler = createMcpHandler(() => createGeoBsServer(env), {
      route: "/mcp",
      legacy: "stateless",
      responseMode: "auto"
    });
    return handler(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
