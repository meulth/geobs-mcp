# Public API documentation and gateways

The Node.js runtime serves a local Swagger UI at **`/docs`** and an OpenAPI
**3.1.0** document at **`/openapi.json`**. The document is generated once per
server instance from the same tool registration, descriptions and Zod input/
output schemas as MCP. Public example arguments live alongside those definitions
and are parsed against the actual input schemas at startup. No independent
tool schema catalog or REST adapter is maintained.

The design follows the [DCC-BS MCP documentation](https://mcp.data.bs.ch/docs)
and its [JSON-RPC OpenAPI implementation](https://github.com/DCC-BS/mcp-data-bs/blob/main/api_docs.py):
one `POST /mcp` operation with a request `oneOf` and named examples for all seven
tools. This is functional alignment, not a dependency on the DCC service.
The existing Cloudflare entry point is retained; these documentation routes
are provided by the standalone Node.js runtime.

## Explore and try tools

1. Open `/docs`, expand `POST /mcp`, and click **Try it out**.
2. Select a named example (one of the seven tools, `tools/list` or `initialize`).
3. Review/edit its JSON-RPC body and click **Execute**.
4. Read the JSON-RPC result. A controlled tool failure can have HTTP 200 and
   `result.isError: true`; HTTP success alone does not prove a successful query.

Examples use public illustrative places/coordinates. For a real location,
resolve its exact coordinates with `search_api_v2`; discover current collection
IDs with `search_datasets_ogc` before querying features. The sample bbox/point
does not assert that it is the resolved coordinate of the sample address.
GeoBS source availability, coverage and the weekly catalog still bound results.
Search v2 and Grundstückinfo require the operator's existing mounted key file;
visitors never supply or see that key in Swagger.

Every tool example is a **JSON-RPC** request, for example:

```sh
curl --no-buffer 'https://api.example.test/geobs-mcp/v1/mcp' \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --header 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_datasets_ogc","arguments":{"query":"Strassennamen","limit":3}}}'
```

Swagger's local request interceptor sets Content-Type, the complete Accept
header and the supported legacy protocol version above, replacing headers
case-insensitively. Accept is not represented as an OpenAPI header parameter:
the [OpenAPI specification](https://spec.openapis.org/oas/v3.1.0.html#parameter-object)
requires tools to ignore a parameter named Accept. Its actual wire value is
covered by a real-browser test, as is the generated curl example.

These low-level examples use supported **stateless legacy MCP**. Each POST
finishes after its result; its SSE `data:` frames carry JSON-RPC envelopes.
Swagger displays the raw event stream, not a fabricated JSON response. Do not
`JSON.parse` the whole SSE body; parse frames or use an MCP SDK. The spec also
describes JSON responses, protocol errors and accepted notifications. It does
not expose an indefinite GET stream through Try it out. Modern SDK negotiation,
JSON responses and legacy SSE remain available on the same MCP endpoint.

Swagger UI JavaScript and CSS are pinned npm build inputs, embedded into the
Node bundle and served by the app. No CDN, external validator or externally
loaded specification is required. Its validator is disabled and its content
security policy restricts scripts and connections to the same origin. Generated
documentation performs no tool calls or catalog fetches. **Execute** invokes the
normal tool handler and therefore consumes the same bounded API capacity.
Swagger's license, NOTICE and bundled dependency notices are included in the
artifact's `THIRD-PARTY-NOTICES.txt`; npm installation analytics are disabled
through the repository's `scarfSettings`.

## Configure the public prefix

Set `GEOBS_PUBLIC_BASE_PATH=/geobs-mcp/v1` in the Node/container environment, or
with Helm:

```yaml
config:
  publicBasePath: /geobs-mcp/v1
  allowedHosts:
    - api.example.test
    - localhost:8080
    - 127.0.0.1:8080
  allowedOrigins:
    - https://api.example.test
```

The value is an absolute **path**, not a hostname/URL, with no trailing slash,
query, percent encoding or dot segments. Segments accept letters, digits, `_`
and `-`. Empty means no prefix; native configuration also normalizes `/` to
empty. Prefixes rooted in `/mcp`, `/docs` or `/health` are reserved to prevent
route collisions. Forwarded headers never determine the public prefix or Host.

| Public URL | Behaviour |
| --- | --- |
| `/geobs-mcp/v1` or `/geobs-mcp/v1/` | Swagger UI |
| `/geobs-mcp/v1/docs` | Swagger UI alias and local assets below `/docs/` |
| `/geobs-mcp/v1/openapi.json` | OpenAPI with same-origin server `/geobs-mcp/v1` |
| `/geobs-mcp/v1/mcp` | Existing MCP transport via an explicit configured alias |

Internal `/mcp`, `/docs`, `/openapi.json` and `/health/live`, `/health/ready` remain
available. When a public prefix is set, internal `/` also serves Swagger for a
prefix-stripping gateway. Without a prefix, `/` retains its service-info JSON.
UI links and Try it out always target the configured public prefix, including
when the UI itself is requested via the internal alias.

### API-gateway contract

Both routing modes are supported; choose exactly one in your gateway:

| Gateway policy | Example upstream request |
| --- | --- |
| Preserve configured prefix | `/geobs-mcp/v1/mcp` → `/geobs-mcp/v1/mcp` |
| Strip configured prefix once | `/geobs-mcp/v1/mcp` → `/mcp`; `/geobs-mcp/v1` → `/` |

Route the prefix root **and all its descendants**, including `/docs/*` assets
and `/openapi.json`, to this service. With Kubernetes, target Service port 80
(Pod port 8080). The chart does not install a gateway/ingress, DNS or TLS.
Terminate public HTTPS using the platform's normal configuration.

Preserve the configured public Host authority, or deliberately set an exact
allowed internal Host. Keep the **public browser origin** in allowedOrigins
even if Host is rewritten. Do not trust arbitrary X-Forwarded-Host/Prefix values
or disable Host/Origin checks to make a proxy work. Significant ports belong in
the Host authority. Kubernetes probes keep their explicit loopback Host header.
Clients without Origin remain supported; external browser origins require an
explicit origin allowlist entry.

Forward JSON-RPC bodies without transformation and preserve Content-Type,
Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name and other MCP headers accepted
by the transport. Preserve response Content-Type and streaming data frames;
disable SSE buffering/caching and allow sufficient request/read timeouts for
bounded upstream calls. Do not convert every MCP HTTP 200 into a domain success.
There is no new API-key/OAuth requirement for clients. Apply public traffic
limits at the edge; the upstream GeoBS key stays inside the server.

## Connect external MCP clients

The client URL is **`https://api.example.test/geobs-mcp/v1/mcp`**. `/docs` and
`/openapi.json` are documentation, not MCP connection URLs. Select remote MCP
**Streamable HTTP** and anonymous/no authentication; use an SDK/client that
negotiates MCP rather than treating a tool as an independent REST operation.

- In ChatGPT or another client with remote MCP support, add that complete MCP
  URL using the client's connection settings. Availability and administrative
  permissions depend on the client. Refresh its tool metadata after upgrades.
- In applications such as Bebbi Bot, configure the same URL as the remote MCP
  server. Do not import the OpenAPI description as seven REST tools. Let the MCP
  client handle initialize, protocol headers, tools/list and JSON/SSE responses.
- To verify the connection independently, use the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector@latest --cli \
  https://api.example.test/geobs-mcp/v1/mcp --method tools/list --strict --format json
```

## Reproduce validation

```sh
npm ci
npm run check
npm run build:node
npm run test:node-build
npx playwright install chromium
npm run test:docs
docker build -t geobs-mcp:container-test .
npm run test:container -- geobs-mcp:container-test
npm run test:helm
```

Unit/HTTP tests validate the generated OpenAPI 3.1 document without external
references, compare its source schemas to live tools/list and execute **all
seven published tool examples** plus initialize/list through the real JSON-RPC
handler with synthetic GeoBS responses. They also cover missing keys, malformed
JSON, unacceptable Accept, Host/Origin protection and modern JSON negotiation.

`test:docs` requires installed Playwright Chromium, builds on the compiled
artifact and opens the real Swagger UI in three modes: no prefix, preserved
prefix and a loopback proxy stripping the prefix. It verifies seven selectable
tools, clicks Execute for a cached search, checks actual headers and the visible
raw SSE result, and rejects external browser requests. It uses temporary
synthetic data and no upstream calls/secrets. The opt-in browser test does not
run during Docker builds; compiled/static-asset smoke and unit tests do.

Container smoke additionally checks Swagger/OpenAPI after disconnecting its
network. Helm validation covers the example prefix and rejects invalid prefixes;
it needs the tools described in the [chart guide](../charts/geobs-mcp/README.md).
These are local automated checks, not a test of a production gateway or an
end-to-end conversation in a connected AI application.

References: [Swagger installation](https://swagger.io/docs/open-source-tools/swagger-ui/usage/installation/),
[Swagger interceptors/configuration](https://swagger.io/docs/open-source-tools/swagger-ui/usage/configuration/),
[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
