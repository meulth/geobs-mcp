# End-to-end workflow and V2 outlook

## “Gib mir alle verfügbaren Informationen zur Dufourstrasse 40.”

The MCP server contains no LLM. The ChatGPT or other MCP host decides which tools to call. A productive sequence is:

1. Call `search_location` with `query: "Dufourstrasse 40"`, EPSG:2056 and geometry output.
2. Select the exact address result and reuse its point coordinate.
3. Call `get_property_info` with that point. The tool discovers the live parcel WFS3 collection, intersects the point, extracts its E-GRID, and returns Grundstückinfo.
4. Call `search_datasets` for relevant topics such as `Strassennamen`, `Lärm`, `Bäume`, `Verkehr` or `ÖV`.
5. For each relevant STAC ID, call `get_dataset` and choose an exact related OGC feature collection.
6. Call `query_features` with that collection and a conservative radius around the address.
7. Synthesize the returned source data, keeping dataset dates, CRS and limitations visible.

The observed V1 path for the address is:

```text
search_location
  -> POINT (2611776.302 1266865.109), EPSG:2056
get_property_info
  -> point intersection in current parcel collection
  -> E-GRID
  -> parcel + buildings + addresses + land cover
```

The same point queried against the dynamically discovered Strassennamen feature collection returns nearby street axes including Dufourstrasse.

## Likely additions for complex questions

Questions such as “Wo ist es nachts ruhig?” or “Wo gibt es viel Grün und wenig Verkehr?” need explicit geospatial operations, not a vector database or embedded LLM. Candidate V2 tools are:

- `discover_feature_collections`: search WFS3 layer metadata directly when a STAC product maps to many layers;
- `query_nearby`: a higher-level bounded buffer/intersection tool for several chosen collections;
- `aggregate_features`: safe count, sum, min/max and grouped statistics without arbitrary SQL;
- `spatial_join`: controlled intersection/nearest-neighbour operations between two approved query results;
- `get_coverage_value`: support raster/coverage services if noise or environmental products are not features;
- `compare_areas`: normalize a small set of indicators and expose provenance, dates and uncertainty;
- CRS transformation and geometry simplification for broader multi-dataset analysis;
- pagination handles or downloadable result artifacts for analyses that cannot safely fit in one MCP response.

Before adding any of these, inspect the live GeoBS services and define bounded domain-specific schemas. OAuth should remain separate and is needed only if future tools expose protected/user-specific data or write actions.
