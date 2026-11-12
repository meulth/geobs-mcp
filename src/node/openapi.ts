import { z } from "zod";
import type { ToolDocumentation } from "../mcp/register";

export const DOCS_PROTOCOL_VERSION = "2025-11-25";
export const MCP_ACCEPT = "application/json, text/event-stream";
type Schema = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const id = { oneOf: [{ type: "integer" }, { type: "string" }] };
const envelope = (method: string, params?: Schema): Schema => ({
  type: "object", required: ["jsonrpc", "id", "method", ...(params ? ["params"] : [])],
  additionalProperties: false,
  properties: { jsonrpc: { const: "2.0" }, id, method: { const: method }, ...(params ? { params } : {}) }
});

// Zod emits document-root refs. Relocate them when embedding in OpenAPI and
// hoist each tool's recursive JSON definitions under a collision-free name.
function addSchema(schemas: Record<string, Schema>, name: string, schema: Schema) {
  const { $schema: _dialect, $defs = {}, ...body } = schema;
  function rewrite(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === "$ref" && typeof item === "string" && item.startsWith("#")
        ? item.startsWith("#/$defs/") ? `#/components/schemas/${name}__${item.slice(8)}` : `#/components/schemas/${name}${item.slice(1)}`
        : rewrite(item)
    ]));
  }
  schemas[name] = rewrite(body) as Schema;
  for (const [key, definition] of Object.entries($defs as Record<string, Schema>)) {
    schemas[`${name}__${key}`] = rewrite(definition) as Schema;
  }
}

export function buildOpenApi(tools: readonly ToolDocumentation[], basePath: string, authenticated = false) {
  const schemas: Record<string, Schema> = {};
  const examples: Record<string, { summary: string; description: string; value: unknown }> = {};
  for (const tool of tools) {
    // Validate published examples against the actual input parser at startup.
    tool.inputSchema.parse(tool.example);
    addSchema(schemas, `${tool.name}_input`, z.toJSONSchema(tool.inputSchema, { io: "input" }));
    addSchema(schemas, `${tool.name}_output`, z.toJSONSchema(tool.outputSchema, { io: "output" }));
    const example = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: tool.example } };
    schemas[`${tool.name}_request`] = {
      ...envelope("tools/call", {
        type: "object", required: ["name", "arguments"], additionalProperties: false,
        properties: { name: { const: tool.name }, arguments: ref(`${tool.name}_input`) }
      }), title: tool.title, description: tool.description, example
    };
    examples[tool.name] = { summary: tool.name, description: tool.description, value: example };
  }
  schemas.ToolsListRequest = envelope("tools/list");
  examples.tools_list = { summary: "tools/list", description: "Discover the live MCP tool definitions.", value: { jsonrpc: "2.0", id: 1, method: "tools/list" } };
  schemas.InitializeRequest = envelope("initialize", {
    type: "object", required: ["protocolVersion", "capabilities", "clientInfo"],
    properties: {
      protocolVersion: { type: "string" }, capabilities: { type: "object" },
      clientInfo: { type: "object", required: ["name", "version"], properties: { name: { type: "string" }, version: { type: "string" } } }
    }
  });
  examples.initialize = {
    summary: "initialize", description: "SDK clients initialize automatically. This stateless server needs no session ID.",
    value: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: DOCS_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "swagger-ui", version: "1" } } }
  };
  schemas.JsonRpcError = {
    type: "object", required: ["jsonrpc", "id", "error"],
    properties: {
      jsonrpc: { const: "2.0" }, id: { anyOf: [id, { type: "null" }] },
      error: { type: "object", required: ["code", "message"], properties: { code: { type: "integer" }, message: { type: "string" }, data: {} } }
    }
  };
  schemas.ToolResult = {
    type: "object", required: ["jsonrpc", "id", "result"],
    properties: {
      jsonrpc: { const: "2.0" }, id,
      result: {
        type: "object", required: ["content"],
        properties: {
          isError: { type: "boolean" },
          content: { type: "array", items: { type: "object", required: ["type", "text"], properties: { type: { const: "text" }, text: { type: "string" } } } },
          structuredContent: { anyOf: tools.map(tool => ref(`${tool.name}_output`)) }
        }
      }
    }
  };
  return {
    openapi: "3.1.0", jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    info: {
      title: "GeoBS MCP API", version: "0.1.0",
      description: "Five read-only MCP tools for Basel-Stadt geodata. Select a JSON-RPC example under POST /mcp and use Try it out. " +
        "This is one MCP transport endpoint, not a REST endpoint per tool. Swagger uses the supported stateless legacy protocol and displays finite SSE responses as raw event frames. " +
        "Normal MCP clients negotiate their protocol through initialize. Tool errors can be HTTP 200 with result.isError=true; protocol errors use a JSON-RPC error envelope. " +
        "Examples use public illustrative places/coordinates; discover exact current layer IDs and resolve address coordinates for your own question. Search v2 and Grundstückinfo require an operator-provided API key; users never enter that key here."
    },
    servers: [{ url: basePath || "/", description: "Same-origin public base path" }],
    paths: {
      "/mcp": {
        post: {
          operationId: "mcpRequest", summary: "Call a GeoBS MCP tool", tags: ["MCP"],
          description: tools.map(tool => `### ${tool.name}\n${tool.description}`).join("\n\n") +
            "\n\nSend Content-Type: application/json and Accept: application/json, text/event-stream. " +
            "The local Swagger request interceptor enforces Accept (OpenAPI header parameters named Accept are ignored). " +
            (authenticated ? "Personal OAuth is required at the Access gateway. Use the browser's authenticated same-origin Access session or an OAuth access token; never enter the server's upstream API key or an origin JWT. "
              : "No bearer token, API-key header or session ID is needed. ") +
            "SSE data frames contain JSON-RPC envelopes; do not JSON.parse the whole event stream. " +
            "Only finite POST exchanges are offered here; use an MCP SDK for protocol negotiation and streaming lifecycle.",
          parameters: [{ name: "MCP-Protocol-Version", in: "header", required: true, schema: { type: "string", const: DOCS_PROTOCOL_VERSION, default: DOCS_PROTOCOL_VERSION }, description: "Legacy stateless version used by these low-level examples; SDK clients can negotiate modern JSON as before." }],
          requestBody: { required: true, content: { "application/json": {
            schema: { oneOf: [...tools.map(tool => ref(`${tool.name}_request`)), ref("ToolsListRequest"), ref("InitializeRequest")] }, examples
          } } },
          responses: {
            ...(authenticated ? { "401": { description: "Personal authentication required. WWW-Authenticate identifies OAuth protected-resource metadata; complete discovery/login at the public gateway." },
              "403": { description: "The gateway's signed identity assertion was refused by this server (for example wrong application, key or lifetime). Signing in again does not help; the operator finds the reason code in the server log." } } : {}),
            "200": { description: "Tool result (including controlled tool errors), tools/list or initialize result. SSE data frames carry the same JSON-RPC envelopes.", content: {
              "application/json": { schema: { anyOf: [ref("ToolResult"), ref("JsonRpcError"), { type: "object", required: ["jsonrpc", "id", "result"], properties: { jsonrpc: { const: "2.0" }, id, result: { type: "object" } } }] } },
              "text/event-stream": { schema: { type: "string" }, example: 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"<tool output>"}],"isError":false}}\n\n' }
            } },
            "202": { description: "Accepted notification/response, no body. SDK clients manage these exchanges." },
            default: { description: "Transport/protocol failure (400/403/405/406/413/415/500). A Host/Origin rejection or proxy failure may have an empty/non-JSON body.", content: { "application/json": { schema: ref("JsonRpcError") }, "text/event-stream": { schema: { type: "string" } } } }
          }
        }
      }
    },
    ...(authenticated ? { security: [{ personalOAuth: [] }] } : {}),
    components: { schemas, ...(authenticated ? { securitySchemes: { personalOAuth: {
      type: "http", scheme: "bearer", description: "Opaque OAuth access token accepted by the Access gateway. The origin validates the gateway's signed personal identity; it never accepts this header alone."
    } } } : {}) }
  };
}
