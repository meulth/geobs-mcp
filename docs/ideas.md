# Project roadmap

Ideas describe possible future work, not automatic implementation instructions.
Current tools and supported behavior are documented in [README](../README.md).

## Open ideas

| ID | Idea | Main prerequisite or limit |
| --- | --- | --- |
| GEO-001 | Improve parcel-layer selection | Reproduce ambiguous ranking between parcel and boundary-point layers. |
| GEO-006 | Explain supported filter fields | Establish whether authoritative queryables/schema metadata is available. |
| GEO-007 | True radius search for points in EPSG:2056 | Filter bbox candidates by distance, sort before output limits and expose potentially missing candidates. Analysis complete; no prototype implemented. |
| GEO-008 | Bounded, transparent statistics | Distinguish full data from limited samples. |
| GEO-009 | Read raster values at a location | First verify a suitable queryable coverage service. |
| GEO-010 | Address report with sources and gaps | Reuse existing calls with explicit dates, coverage and query limits. |
| GEO-011 | Compare two locations | Use equivalent coverage and comparable indicators. |
| GEO-012 | Export a small map view | Verify CRS, geometry handling and data rights. |
| GEO-013 | Compare data snapshots | Require stable IDs and comparable timestamps. |
| GEO-014 | Observation walk based on data gaps | Do not infer public access or safe walking routes from proximity. |
| GEO-015 | Hypothetical greening scenario | State assumptions; do not claim climate or engineering predictions. |

## Implemented capabilities

- Structured HTTP, MCP-tool, upstream and catalog telemetry.
- Client-compatible array and Unicode field-name schemas.
- Weekly OGC metadata cache and direct layer search.
- Inferred four-character STAC product IDs in layer results.
- Five tools named by their purpose and data source.

Technical constraints and known limitations belong in public documentation.
Installation-specific records and internal handoffs are maintained separately.
