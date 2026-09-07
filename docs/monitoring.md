# Structured telemetry

The Worker emits structured JSON events that can be consumed by a monitoring
system of your choice. No particular collector, dashboard or hosted monitoring
account is required by this repository.

## Event format

Events contain `service=geobs-mcp`, `schema_version=1`, `event_id`, `timestamp`,
`request_id`, `event`, `outcome` and `duration_ms`.
Durations measure elapsed processing time, including upstream waits where
applicable; they are not CPU measurements. Request IDs correlate related events.

| Event | Additional fields | Meaning |
| --- | --- | --- |
| `http_request` | `route`, `method`, `status` | One completed HTTP request; MCP protocol requests also count. |
| `mcp_tool` | `tool`, `output_bytes` on success, `error_code` on failure | A completed registered tool callback. |
| `geobs_upstream` | `upstream`, optional `status`, `response_bytes`, `error_code` | One GeoBS HTTP attempt, including body reading and JSON parsing. |
| `catalog_cache` | On success: `catalog_age_seconds`, `catalog_stale`, `collection_count`; on failure: `error_code` | A KV catalog read and validation. |
| `catalog_refresh` | On success: `collection_count`, `snapshot_bytes`, `changed`; on failure: `error_code` | One scheduled catalog refresh attempt. |

Active tool values:

- `search_api_v2`
- `search_datasets_ogc`
- `get_dataset_stac`
- `query_features_ogc`
- `get_property_info`

Upstream values: `search`, `stac`, `ogc_features`, `property_info`, `other`.
Routes: `mcp`, `health`, `other`.
Error codes are defined in [errors.ts](../src/errors.ts).

## Interpretation

Count completed `mcp_tool` events for tool usage. HTTP and upstream counts are
different quantities: a tool can make multiple upstream calls, and MCP
initialization or tool discovery does not execute a tool.

A failed tool result can arrive with HTTP 200. Inputs rejected by the SDK before
the callback and unknown tool names do not produce a completed tool event.
Worker termination can prevent completion events; platform logs provide
additional context. A GET /mcp returning 405 may be a client's optional SSE
probe, so inspect it separately from tool failures.

`NO_RESULTS`, `DATASET_NOT_FOUND` and `COLLECTION_NOT_FOUND` can describe normal
query outcomes rather than an infrastructure outage. No events means no
observation, not proof of zero usage. These events do not identify unique users.

## Collector guidance

Use the event ID for deduplication and the event timestamp for ingestion.
Keep a checkpoint only after successful ingestion. Validate bounded fields,
allow known schema versions and handle late data explicitly.
Do not turn unique event/request IDs into metric labels.

When upgrading from earlier tool names, update collector allowlists and
dashboard filters. Preserve historical values where retained logs use them:

| Previous name | Current name |
| --- | --- |
| `search_location` | `search_api_v2` |
| `search_feature_collections` | `search_datasets_ogc` |
| `get_dataset` | `get_dataset_stac` |
| `query_features` | `query_features_ogc` |

`search_datasets` was removed when topic discovery moved to the OGC cache.
It is not an alias for the new search. Upstream labels remain unchanged.

## Data minimization

Application events omit tool arguments, search terms, addresses, coordinates,
property IDs, response data, raw URLs, headers and credentials. Keep the same
restrictions when building an exporter. Platform-generated logs are separate
and may contain additional request metadata; do not forward them wholesale.
Store monitoring credentials outside source control.

See [telemetry.ts](../src/telemetry.ts), [register.ts](../src/mcp/register.ts)
and [http.ts](../src/http.ts) for the event producers.
