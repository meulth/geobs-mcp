# End-to-end workflow and V2 outlook

## “Gib mir alle verfügbaren Informationen zur Dufourstrasse 40.”

The MCP server contains no LLM. The ChatGPT or other MCP host decides which tools to call. A productive sequence is:

1. Call `search_api_v2` with `query: "Dufourstrasse 40"`, EPSG:2056 and geometry output.
2. Select the exact address result and reuse its point coordinate.
3. Call `get_property_info` with that point. The tool discovers the live parcel WFS3 collection, intersects the point, extracts its E-GRID, and returns Grundstückinfo.
4. Call `search_datasets_ogc` for relevant topics such as `Strassennamen`, `Lärm`, `Bäume`, `Verkehr` or `ÖV`. It searches the weekly OGC cache and returns individual layers with match reasons.
5. Use a result's exact `id` for feature queries. If product metadata or downloads are needed, pass its inferred `stacDatasetId` to `get_dataset_stac`. The product code is derived from the naming convention, not verified during search; an unrecognised naming pattern omits it. Multiple layers can share the same product ID. Products without OGC layers are not searchable, but can still be loaded by known STAC ID.
6. For Point features within an air-line radius, call `query_features_ogc` with `spatialMode: "circle"`, the exact address point in EPSG:2056 and an explicit radius in meters (0–1000). Use `spatialMode: "bbox"` for polygons/lines or rectangular candidate queries; these are not circle results.
7. Synthesize the returned source data, keeping dataset dates, CRS and limitations visible.

The observed V1 path for the address is:

```text
search_api_v2
  -> POINT (2611776.302 1266865.109), EPSG:2056
get_property_info
  -> point intersection in current parcel collection
  -> E-GRID
  -> parcel + buildings + addresses + land cover
```

The same point queried against the dynamically discovered Strassennamen feature collection returns nearby street axes including Dufourstrasse.

## Radius and answer contract

Circle mode loads one bounded page of at most 25 box candidates, calculates horizontal
LV95 distances, includes the circle boundary, excludes box corners, sorts by unrounded
distance, then applies the requested result limit. It accepts only valid Point geometries;
unsupported/missing geometry or a contradictory CRS fails explicitly. A missing CRS header
is disclosed: the fixed GeoBS service advertises and receives the requested CRS, but does
not necessarily confirm it in the response header. No automatic pagination or routing.

Use returned `distanceMeters` and the echoed `spatial.center`. `numberMatched` describes
upstream box candidates; it is never a circle total. `coverage.complete` also accounts for
unknown counts, next pages, inconsistent counters, local candidate clipping, the result
limit and output-byte truncation. Exactly 25 of 25 with no next page is not itself a gap.
If candidates are incomplete, missing points may be closer than all returned points.
Completeness is scoped to the selected collection/query, not all real-world objects.

Ask which place, radius and topic the user means when these are unclear. Preserve exact
coordinates across follow-ups. An address point is not a verified entrance. Cite source
URLs and collection IDs/E-GRIDs, and state when the feature update date is unknown;
cache, response and retrieval timestamps are different from a verified update date.
Zero metadata matches only describe the bounded OGC search. Planning noise classes
are not measurements. Agree on comparable areas and measurable criteria before comparing;
neither planning-zone counts nor stop counts alone justify greenery or transport rankings.

The server provides deterministic distance/coverage fields and host instructions. The
host still selects tools, retains conversation context and writes the final answer;
successful unit/MCP tests do not prove every generated chat answer follows these rules.

## Likely additions for complex questions

Questions such as “Wo ist es nachts ruhig?” or “Wo gibt es viel Grün und wenig Verkehr?” need explicit geospatial operations, not a vector database or embedded LLM. Candidate V2 tools are:

- `query_nearby`: a higher-level bounded buffer/intersection tool for several chosen collections;
- `aggregate_features`: safe count, sum, min/max and grouped statistics without arbitrary SQL;
- `spatial_join`: controlled intersection/nearest-neighbour operations between two approved query results;
- `get_coverage_value`: support raster/coverage services if noise or environmental products are not features;
- `compare_areas`: normalize a small set of indicators and expose provenance, dates and uncertainty;
- CRS transformation and geometry simplification for broader multi-dataset analysis;
- pagination handles or downloadable result artifacts for analyses that cannot safely fit in one MCP response.

Before adding any of these, inspect the live GeoBS services and define bounded domain-specific schemas. OAuth should remain separate and is needed only if future tools expose protected/user-specific data or write actions.
