# Observed GeoBS APIs and STAC↔WFS3 analysis

Observed against the public services on 2026-08-28. These are runtime observations, not hardcoded catalog contents.

## STAC

Base URL: `https://api.geo.bs.ch/stac/v1/`

- The trailing slash landing page works and advertises Collections, Conformance, GET/POST Search and OpenAPI links.
- The catalog reports STAC 1.0.0 and STAC API Collections, Core, Item Search and OGC API Features conformance.
- 95 collections were returned during analysis.
- Collections provide ID, title, description, keywords, themes, providers, license, spatial/temporal extent, `proj:code`, links and optional assets.
- Items represent published versions such as `latest` and expose download assets including GeoJSON, CSV, FlatGeobuf, GeoPackage, Shapefile and FileGDB where available.
- The original MCP dataset search fetched collections and ranked metadata locally. Current topic discovery uses the OGC cache through `search_datasets_ogc`; `get_dataset_stac` loads a known product and its items directly.

For `STNA`, the observed collection title is `Strassennamen`, its declared CRS is EPSG:2056, and its `latest` item exposes multiple download formats.

Some STAC links currently carry `auth:refs: ["oidc"]`, although the inspected collection and item endpoints respond anonymously. V1 uses the observed anonymous behavior and implements no OIDC functionality.

## Search API v2

Base URL: `https://api.geo.bs.ch/search/v2`

OpenAPI defines `GET /search` with:

- required `term`
- `maxresults` and `partitionlimit`
- `outputformat`: `geom`, `bbox` or `centroid`
- `epsg`
- repeated `type` filters

Advertised types include address, address ID, Basel Info, E-GRID, building IDs, public transport stops, parcel number and streets/places/parks.

The actual response is an array. Each observed entry has `label`, `layer_name`, WKT in `geom`, and a useful `details` object even though `details` is absent from the published response schema. The client validates the required fields and preserves `details`.

Observed address result:

```text
Dufourstrasse 40, 4052 Basel
POINT (2611776.302 1266865.109)
EPSG:2056
```

The API key is transported only in the `apikey` request header. It never appears in a URL or MCP response.

## Grundstückinfo

Base URL: `https://api.geo.bs.ch/grundstueckinfo/v1`

OpenAPI advertises:

- `GET /realestatesinformation`
- `GET /realestates`
- `GET /buildings`
- `GET /landcovers`
- `GET /landcoversreport` (PDF)

The JSON endpoints require one or more E-GRIDs or section/parcel identifiers in `ids`. `realestatesinformation` can add GeoJSON geometry with `withgeometry`.

The service does not accept a point directly. `get_property_info` therefore uses this dynamic read-only sequence when given a Search result point:

1. read WFS3 collection metadata from the weekly cache;
2. identify the parcel/real-estate collection semantically, without a fixed collection ID;
3. query the exact point in the point CRS;
4. read the E-GRID property;
5. call `realestatesinformation` with that E-GRID.

For the observed Dufourstrasse point, this produced one parcel and Grundstückinfo returned parcel metadata, two related buildings, addresses, links and land-cover percentages. The actual building response uses `Adress` in places where OpenAPI documents `Adresses`; V1 preserves the upstream data rather than relying on that spelling.

## OGC API Features / WFS3

Base URL: `https://api.geo.bs.ch/ogc/v1/wfs3`

- The landing page links Collections, Conformance and a generated OpenAPI document.
- 894 feature collections were returned during analysis.
- Conformance declares OGC API Features Core, OAS 3.0, HTML and GeoJSON.
- Collections commonly advertise CRS84 plus EPSG:4326, EPSG:2056, EPSG:3857 and EPSG:4258.
- `bbox`, `bbox-crs`, output `crs`, `limit`, `properties` and collection-specific exact property query parameters work.
- CQL/filter conformance was not advertised. V1 does not expose raw CQL. It permits at most five validated exact property filters and lets the collection endpoint reject properties it does not support.
- A zero-area bbox (`x,y,x,y`) works as a point intersection query and is used for E-GRID resolution.
- The metadata endpoints reject a combined JSON/GeoJSON `Accept` header; the client therefore sends `application/json` for metadata and `application/geo+json` for feature items.

## STAC to WFS3 relationship

### What exists now

No direct WFS3 collection links were found in the inspected STAC collection or item links. STAC item assets point to bulk downloads, not OGC feature collections.

There is, however, a strong naming convention. The STAC dataset code appears as a delimited token inside WFS3 collection IDs:

```text
STAC: STNA
WFS3: ch.bs.strassennamen_stna
```

For multi-layer datasets it appears before the layer suffix:

```text
STAC: AVPZ
WFS3: ch.bs.av_parzellen_rechtliche_abgrenzungen_avpz.liegenschaft
```

Measured results across the live catalogs:

| Result | Count |
| --- | ---: |
| STAC collections | 95 |
| WFS3 collections | 894 |
| STAC collections with code-token WFS3 matches | 94 |
| Exactly one WFS3 match | 52 |
| Multiple layer/representation matches | 42 |
| No match | 1 (`AVBS`, an Interlis product) |

Titles and descriptions also agree in many cases, but the shared dataset code is a less ambiguous machine key.

### Answers to the discovery questions

1. A client can currently infer corresponding WFS3 collections by fetching all WFS3 metadata and matching the delimited STAC code.
2. Direct links were not observed.
3. A shared code exists by convention in 94/95 observed datasets, but it is not an explicit WFS metadata field.
4. The convention is highly effective for the current catalog, including one-to-many datasets, but it is not contractually reliable because it is neither linked nor formally declared.
5. The smallest robust metadata improvement is to add explicit WFS3 collection references to each STAC collection. A `related` link can point at each OGC collection JSON document and use a clear title such as `OGC API Features collection`. For fully deterministic machine interpretation, additionally publish a small namespaced property such as `geobs:ogc_feature_collection_ids` (with a documented STAC extension/schema). This removes the need to download and scan all 894 collections and cleanly represents one-to-many mappings.

V1 uses the dynamic code-token match and reports the method and all discovered collection IDs. It does not contain a mapping table.
