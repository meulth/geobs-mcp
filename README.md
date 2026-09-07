# geobs-mcp

Open-source MCP server for accessing Basel-Stadt geospatial data via STAC, OGC API Features and GeoBS APIs.

`geobs-mcp` is a read-only Remote MCP server for Cloudflare Workers. It exposes five focused geo tools through a stateless MCP handler, with a shared weekly OGC metadata catalog in Workers KV. It supports the public GeoBS STAC catalog, OGC API Features/WFS3, Search API v2 and Grundstückinfo.

## Status

The server exposes five read-only tools. It uses:

- TypeScript and Cloudflare Workers
- the stable MCP TypeScript SDK v2 via `@modelcontextprotocol/server`
- Cloudflare's stateless `createMcpHandler`
- Streamable HTTP at `/mcp`
- Workers KV for OGC collection metadata, refreshed Wednesday at 03:00 Europe/Zurich
- no Durable Objects, SQL database, queue, OAuth or LLM

The design follows the current [Cloudflare stateless MCP handler documentation](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), the [MCP transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), and the official OpenAI guidance for [building](https://developers.openai.com/plugins/build/mcp-server) and [connecting](https://developers.openai.com/plugins/deploy/connect-chatgpt) MCP-backed plugins.

## Tools

| Tool | GeoBS API | Purpose |
| --- | --- | --- |
| `search_api_v2` | Search v2 | Resolve addresses, streets, places and supported identifiers to reusable geometry/coordinates. |
| `get_dataset_stac` | STAC + WFS3 | Return metadata, assets, items and dynamically related feature collections. |
| `query_features_ogc` | OGC API Features | Run bounded bbox or point/radius feature queries with controlled exact filters. |
| `get_property_info` | WFS3 + Grundstückinfo | Resolve a point to an E-GRID, then return parcel, building and land-cover information. |
| `search_datasets_ogc` | Cached WFS3 catalog | Search topics, titles, descriptions and IDs; return exact layer IDs, inferred four-character STAC product IDs, match reasons and catalog age. |

All tools advertise read-only, non-destructive, idempotent and closed-world annotations. Their inputs and structured outputs have JSON schemas.

`search_api_v2` uses **GeoBS Search API v2**, at `/search/v2`.

The tool renames from the previous interface are `search_location` → `search_api_v2`, `get_dataset` →
`get_dataset_stac`, `search_feature_collections` → `search_datasets_ogc`, and
`query_features` → `query_features_ogc`. `get_property_info` is unchanged.
There are no aliases for old names; the tool count remains five. Refresh client
tool lists after deployment and update integrations that call the old names.

`search_datasets_ogc` replaces `search_datasets`. Pass a result's `id` to
`query_features_ogc`, or its `stacDatasetId` to `get_dataset_stac` for live metadata and
downloads. The product ID is inferred from the GeoBS OGC naming convention;
`stacDatasetIdSource` identifies that provenance, and unmatched IDs omit the field.
Several layers can share a product ID. No STAC catalog request is made during
topic search. Products without OGC layers cannot be found by this search but
remain accessible through `get_dataset_stac` when their ID is known. After deploying
this change, refresh existing MCP connections to remove the old tool.

## Quick start

Requirements: Node.js 20 or newer and a valid GeoBS Search API key.

```bash
npm install
```

Copy the example local secret file:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Set only your own key in `.dev.vars`:

```dotenv
GEOBS_API_KEY="your-key"
```

`.dev.vars` and `.env` files are ignored by Git. Never put a real key in source, tests, fixtures, the Wrangler configuration or logs.

Prepare the public OGC catalog and seed local KV, then start the Worker:

```bash
npm run catalog:prepare
npx wrangler kv key put ogc-catalog:v1 --binding OGC_CATALOG --path .wrangler/ogc-catalog.json --local
npm run dev
```

The local URLs are normally:

- health: `http://127.0.0.1:8787/`
- MCP: `http://127.0.0.1:8787/mcp`

Opening `/mcp` in a browser is not an MCP test; the endpoint expects protocol requests.

## Test with MCP Inspector

Start the current Inspector web UI:

```bash
npx @modelcontextprotocol/inspector@latest
```

Choose Streamable HTTP and connect to `http://127.0.0.1:8787/mcp`.

The CLI can verify schemas and invoke a tool without a browser:

```bash
npx @modelcontextprotocol/inspector@latest --cli http://127.0.0.1:8787/mcp --method tools/list --strict --format json

npx @modelcontextprotocol/inspector@latest --cli http://127.0.0.1:8787/mcp --method tools/call --tool-name search_datasets_ogc --tool-arg query=Strassennamen limit=2 --format json
```

## Tests

```bash
npm run check
npm run test:integration
```

`npm run check` runs strict TypeScript checking and unit tests. Live integration tests are separate and clearly marked. Tests that use Search v2 or Grundstückinfo are skipped when `GEOBS_API_KEY` is absent; the anonymous STAC and WFS3 tests still run.

The validated V1 scenarios are:

- discover OGC layers and their inferred STAC product IDs for `Strassennamen`
- load STAC metadata and assets for `STNA` (Strassennamen)
- query WFS3 near Dufourstrasse 40 in EPSG:2056
- with a key: resolve the address, dynamically find its parcel/E-GRID and retrieve Grundstückinfo
- list and call the five tools through the Streamable HTTP MCP endpoint
- search OGC metadata directly, including multiple layers per product, without a full upstream catalog request

## Deploy to Cloudflare Workers

Authenticate Wrangler without changing unrelated account resources:

```bash
npx wrangler login
```

Store the GeoBS key as the required Worker secret. Wrangler prompts for the value and does not print it:

```bash
npx wrangler secret put GEOBS_API_KEY
```

Run checks and deploy:

```bash
npm run check
npm run deploy
```

Wrangler prints a URL similar to:

```text
https://geobs-mcp.<your-subdomain>.workers.dev
```

The Remote MCP URL is that URL plus `/mcp`.

Smoke-test the deployed server:

```bash
npx @modelcontextprotocol/inspector@latest --cli https://geobs-mcp.<your-subdomain>.workers.dev/mcp --method tools/list --strict --format json
```

View runtime logs and deployments:

```bash
npx wrangler tail geobs-mcp
npx wrangler deployments list
npx wrangler versions list
```

Deploy an update with `npm run deploy`. Roll back interactively to the previous version, or specify a known version ID:

```bash
npx wrangler rollback
npx wrangler rollback <VERSION_ID>
```

A rollback immediately creates a new active deployment. Keep the KV namespace and last good snapshot. The snapshot format is versioned; check compatibility before rolling back to a future version with a different format. Pre-cache versions ignore the namespace.

## Connect to ChatGPT

Current official OpenAI documentation explicitly allows read-only plugin MCP servers to operate anonymously. Authentication discovery is needed only for tools that require an account. V1 therefore intentionally has no OAuth/OIDC stack.

After deployment:

1. Confirm the public HTTPS `/mcp` URL with MCP Inspector.
2. In ChatGPT settings, open **Security and login** and enable **Developer mode**. Availability can depend on account and workspace policy.
3. Open ChatGPT Plugins, add a connection, and enter the complete `https://…workers.dev/mcp` URL.
4. Review the five discovered tools and start a new conversation with the connection enabled.
5. Try: `Gib mir alle verfügbaren Informationen zur Dufourstrasse 40.`

For a private or workspace-only test, developer mode is the intended route; public plugin submission is not required. If a future deployment exposes user-specific data or write actions, implement MCP-conformant OAuth 2.1 then—not in this read-only V1.

### Tool-schema refresh compatibility

Tool schemas use homogeneous fixed-length arrays and server-side Unicode
field-name validation for compatibility across MCP clients. Refresh connection
metadata after tool-name or schema changes. See [schema compatibility](docs/chatgpt-schema-refresh.md)
for implementation details and verification guidance.

## Security model

- Requests can reach only the fixed `https://api.geo.bs.ch` origin.
- No tool accepts a URL, HTTP method, SQL statement or raw query string.
- IDs, property names, filter values, CRS values, result counts and spatial radii are validated.
- Feature responses are limited to 25 records. Every successful MCP result is limited to 250,000 UTF-8 bytes, including its summary, JSON text and structured content (before the transport envelope).
- Large feature results omit geometry first, then reduce records while keeping the returned count accurate. Property results can omit geometry. Responses that still exceed the limit return `RESPONSE_TOO_LARGE`; search and dataset results also pass the final size check.
- GeoBS requests have abort timeouts and response byte limits enforced while reading the response stream.
- Redirects are not followed.
- The Search/Grundstückinfo key is sent only in the server-side `apikey` header.
- Errors contain stable codes and no stack traces, response bodies or secrets.

Expected error codes include `INVALID_INPUT`, `NO_RESULTS`, `DATASET_NOT_FOUND`, `COLLECTION_NOT_FOUND`, `UPSTREAM_UNAVAILABLE`, `TIMEOUT`, `RATE_LIMIT`, `INVALID_UPSTREAM_RESPONSE`, `RESPONSE_TOO_LARGE` and `MISSING_API_KEY`.

Because the endpoint is anonymous, anyone who knows the deployed URL can invoke its bounded read-only tools and consume Worker/API capacity. Add edge rate limiting if the URL is shared broadly.

## Architecture

```text
src/
  clients/          GeoBS HTTP clients and response types
  catalog.ts        validated KV catalog, refresh and Zurich schedule gate
  tools/            each tool's schemas, registration, orchestration and response mapping
  schemas.ts        shared identifier, coordinate and property validation
  discovery.ts      GeoBS-specific STAC/OGC and parcel discovery heuristics
  mcp/server.ts     server and client composition
  mcp/register.ts   shared read-only annotations, execution and error handling
  mcp/results.ts    consistent text/structured results and final output size check
  http.ts           origin allowlist, timeout, size and error handling
  index.ts          stateless Cloudflare Worker entry point
test/
  unit/             mocked API and validation tests
  integration/      explicitly live GeoBS tests
docs/
  api-analysis.md   observed APIs and STAC↔WFS3 findings
  workflow.md       Dufourstrasse workflow and likely V2 tools
```

GeoBS domain logic is independent of the Worker entry point and can be tested with injected `fetch` mocks.

To add a tool, keep its input/output schemas and `registerReadOnlyTool` call in
the tool module, then call its registration function from `mcp/server.ts`.
The shared registration handles MCP errors and output limits. Tools with a
reduction policy use the same result sizing helper, including their summary,
before the final check. API clients share validation schemas with the tools;
GeoBS naming heuristics are kept separate from HTTP access.

## Further documentation

Public documentation contains reusable project guidance. Keep personal deployment
records, account details and infrastructure handoffs in the Git-ignored
`.private/` directory; do not force-add it to source control.

- [Observed GeoBS APIs and STAC↔WFS3 analysis](docs/api-analysis.md)
- [End-to-end workflow and V2 outlook](docs/workflow.md)
- [Structured telemetry and collector guidance](docs/monitoring.md)
- [Project roadmap](docs/ideas.md)
- [OGC catalog: search, cache and operations](docs/ogc-catalog.md)
- [GeoBS terms of use](https://geo.bs.ch/agb)

## License

[MIT](LICENSE)
