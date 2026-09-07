# OGC metadata search and cache

## Discovery

`search_datasets_ogc` searches the cached
[GeoBS OGC collection metadata](https://api.geo.bs.ch/ogc/v1/wfs3/collections?f=json).
The catalog contains layer metadata, not individual features or geometries.

The query contains 2–300 characters and at most 20 distinct normalized words.
The default result limit is 8, with a maximum of 20. All words must occur in
ID, title or description, possibly across different fields. Case, punctuation,
diacritics and German umlaut transliterations are normalized. No fixed layer
list, synonyms, embeddings or LLM is used.

Literal IDs rank first, followed by exact titles and other weighted matches.
`matchReasons` identifies matching fields and terms. Reasons use full metadata;
output titles and descriptions are shortened to 300 and 600 characters.

Each layer remains a separate result. `totalMatches`, `resultCount`,
`searchedCollectionCount` and `truncated` describe result limits.
No matches produces a successful empty list.

## OGC and STAC identifiers

Pass a result's exact `id` to `query_features_ogc`.
When its name matches the GeoBS convention, the result also includes
`stacDatasetId`, suitable for `get_dataset_stac`. For example:

```text
ch.bs.av_parzellen_rechtliche_abgrenzungen_avpz.liegenschaft
                                        AVPZ
```

The code extracts four alphanumeric characters from the product segment behind
`ch.bs.`, before an optional layer suffix. It never guesses from the title or
layer suffix. Unknown naming patterns omit the product ID.
`stacDatasetIdSource=ogc_id_naming_convention` makes the inference explicit;
the search does not verify these IDs with STAC. Multiple layers may share one
product ID. Four-character product codes are a GeoBS-specific convention,
not a general STAC constraint.

This search replaces `search_datasets`. It does not search STAC-only keywords
or products without OGC layers. Such products remain accessible by known ID
through `get_dataset_stac`; an empty search does not prove that no STAC product
exists. STAC metadata, download links and feature data remain live.

## Storage and refresh

The `OGC_CATALOG` KV binding stores one snapshot at `ogc-catalog:v1`.
It includes schema version, fetch timestamp, source URL, content hash, count and
complete collection metadata. No credentials belong in the snapshot.

The configured refresh runs on Wednesday at 03:00 Europe/Zurich. Two UTC cron
slots (`0 1 * * WED`, `0 2 * * WED`) and a timezone-aware gate handle daylight
saving changes. The unused slot does no KV or GeoBS work. To change this schedule,
update both the Wrangler triggers and `isCatalogRefreshTime` together.

Refresh validates the complete response, rejects pagination, duplicate IDs,
empty data and unexpected count changes, and enforces a 25-second upstream
timeout and 12 MB size limit. One KV write replaces the snapshot. Failed refreshes
preserve the previous valid snapshot. The next scheduled run is the next
automatic attempt; administrators can refresh manually.

A snapshot is fresh for 7 days, usable with `catalogStale=true` through day 14,
and rejected after that. Fetch time is not the upstream data's modification time.
Missing, invalid or expired caches fail explicitly without a public full-catalog
fallback. The cache has no automatic expiration and may be briefly inconsistent
across KV locations after a write.

`get_dataset_stac` uses this catalog to find related layers;
`get_property_info` uses it when resolving a point to a parcel.
Direct feature queries by known OGC ID do not need the full catalog.

## Set up your own namespace

Create a KV namespace in your own Cloudflare account:

```bash
npx wrangler kv namespace create OGC_CATALOG
```

Put the returned ID in the `OGC_CATALOG` binding in `wrangler.jsonc`.
A namespace ID from another account cannot be reused.

Prepare and seed local KV for development:

```bash
npm run catalog:prepare
npx wrangler kv key put ogc-catalog:v1 --binding OGC_CATALOG --path .wrangler/ogc-catalog.json --local
npm run dev
```

Seed your remote namespace before first deployment:

```bash
npm run catalog:prepare
npx wrangler kv key put ogc-catalog:v1 --binding OGC_CATALOG --path .wrangler/ogc-catalog.json --remote
npm run deploy
```

For later manual refreshes, first download the remote snapshot as the validation
baseline. These commands use PowerShell and write UTF-8 without a BOM:

```powershell
$catalogJson = npx wrangler kv key get ogc-catalog:v1 --binding OGC_CATALOG --remote --text
if ($LASTEXITCODE -ne 0) { throw 'KV read failed' }
[IO.Directory]::CreateDirectory((Join-Path $PWD '.wrangler')) | Out-Null
[IO.File]::WriteAllText((Join-Path $PWD '.wrangler/ogc-catalog.json'), ($catalogJson -join "`n"), [Text.UTF8Encoding]::new($false))
npm run catalog:prepare
if ($LASTEXITCODE -ne 0) { throw 'Catalog validation failed' }
npx wrangler kv key put ogc-catalog:v1 --binding OGC_CATALOG --path .wrangler/ogc-catalog.json --remote
```

Stop on validation/upload failures and investigate unexpected count changes.
The preparation script and snapshots live under Git-ignored `.wrangler/`.
A CLI upload does not emit a Worker `catalog_refresh` event.

## Usage and monitoring

Catalog consumers read KV; the scheduled refresh downloads metadata and writes
one snapshot. Feature data is not cached. Usage depends on traffic and the
Cloudflare plan; see [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).
Application events are described in [monitoring.md](monitoring.md).
