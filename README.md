# geobs-mcp

Open-source MCP server for accessing Basel-Stadt geospatial data via STAC, OGC API Features and GeoBS APIs.

`geobs-mcp` is a stateless, read-only Remote MCP server for Cloudflare Workers. It exposes five focused geo tools instead of a generic HTTP proxy. The first PoC supports the public GeoBS STAC catalog, OGC API Features/WFS3, Search API v2 and Grundstückinfo.

## Status

V1 PoC is locally functional and deployable. It uses:

- TypeScript and Cloudflare Workers
- the stable MCP TypeScript SDK v2 via `@modelcontextprotocol/server`
- Cloudflare's stateless `createMcpHandler`
- Streamable HTTP at `/mcp`
- no Durable Objects, database, storage, queue, OAuth or LLM

The design follows the current [Cloudflare stateless MCP handler documentation](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), the [MCP transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), and the official OpenAI guidance for [building](https://developers.openai.com/plugins/build/mcp-server) and [connecting](https://developers.openai.com/plugins/deploy/connect-chatgpt) MCP-backed plugins.

## Tools

| Tool | GeoBS API | Purpose |
| --- | --- | --- |
| `search_location` | Search v2 | Resolve addresses, streets, places and supported identifiers to reusable geometry/coordinates. |
| `search_datasets` | STAC | Search all current collection metadata dynamically. |
| `get_dataset` | STAC + WFS3 | Return metadata, assets, items and dynamically related feature collections. |
| `query_features` | OGC API Features | Run bounded bbox or point/radius feature queries with controlled exact filters. |
| `get_property_info` | WFS3 + Grundstückinfo | Resolve a point to an E-GRID, then return parcel, building and land-cover information. |

All tools advertise read-only, non-destructive, idempotent and closed-world annotations. Their inputs and structured outputs have JSON schemas.

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

Start the Worker:

```bash
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

npx @modelcontextprotocol/inspector@latest --cli http://127.0.0.1:8787/mcp --method tools/call --tool-name search_datasets --tool-arg query=Strassennamen limit=2 --format json
```

## Tests

```bash
npm run check
npm run test:integration
```

`npm run check` runs strict TypeScript checking and unit tests. Live integration tests are separate and clearly marked. Tests that use Search v2 or Grundstückinfo are skipped when `GEOBS_API_KEY` is absent; the anonymous STAC and WFS3 tests still run.

The validated V1 scenarios are:

- discover datasets for `Strassen`
- load STAC metadata and assets for `STNA` (Strassennamen)
- query WFS3 near Dufourstrasse 40 in EPSG:2056
- with a key: resolve the address, dynamically find its parcel/E-GRID and retrieve Grundstückinfo
- list and call the five tools through the Streamable HTTP MCP endpoint

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

A rollback immediately creates a new active deployment. No storage migration is involved because this Worker has no persistent infrastructure.

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

On 7 September 2026, ChatGPT reported `Invalid MCP tool schema for tool
'query_features'` while refreshing the connection. The deployed `bbox` schema
used Zod's tuple representation (`prefixItems` without `items`). It now uses a
homogeneous numeric array with `items`, `minItems: 4` and `maxItems: 4`.
The two-value coordinate output uses the same portable representation.
Runtime checks still reject incorrect lengths and nonnumeric coordinates.

The MCP regression tests inspect the actual `tools/list` response for this
array shape across all input and output schemas. These tests do not run
ChatGPT's private importer; after deploying a schema change, refresh the
existing connection in ChatGPT to verify that client as well.

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

- [Observed GeoBS APIs and STAC↔WFS3 analysis](docs/api-analysis.md)
- [End-to-end workflow and V2 outlook](docs/workflow.md)
- [Grafana monitoring: analysis, event schema and collector contract](docs/monitoring.md)
- [Project ideas and status for dashboard-guy](docs/ideas.md)
- [GeoBS terms of use](https://geo.bs.ch/agb)

## License

[MIT](LICENSE)
