# OEREB extracts and property selection

Two read-only tools use the public Basel-Stadt OEREB service at
`https://api.oereb.bs.ch`. They require no upstream API key. A deployment's
existing MCP authentication still applies. They share the existing `/mcp`
endpoint and generated Swagger/OpenAPI documentation; no new REST endpoint,
PDF storage, background job or database is introduced.

## JSON extract: `get_oereb_extract`

Provide exactly one E-GRID or one LV95 point:

```json
{ "egrid": "CH516702897010" }
```

```json
{ "point": { "x": 2613004, "y": 1269174.9, "epsg": 2056 } }
```

These examples identify different properties. The point example returned
`CH187289677283` when checked; do not substitute the E-GRID of the first example.

For an address, call `search_api_v2` with `epsg: 2056` first. Clarify ambiguous
addresses and copy the selected coordinates exactly. An address point is not a
verified entrance or a guaranteed exact parcel match. The OEREB specification
allows a one-metre capture radius for coordinate lookups; this is not a measured
guarantee of this server's upstream implementation.

The tool resolves a point through `/getegrid/json/?EN=x,y`:

- No match: returns `NO_RESULTS`; this does not prove the property does not exist.
- One distinct E-GRID: fetches its JSON extract.
- Several distinct E-GRIDs: returns `status: selection_required`, the original
  candidates, display `choices` and the lookup source, without fetching any extract. Show the user
  each choice's full property type, section, parcel number and E-GRID. Ask which property
  they mean, then call the tool again with that E-GRID. Order is not a ranking.
- Repeated records with the same E-GRID do not create an artificial choice.

The E-GRID is the follow-up key; a parcel number alone may be ambiguous across
numbering areas. Do not prefer the first candidate or discard a property type
without instruction. No server-side dialogue session is needed.

For multiple E-GRIDs, the tool discovers the current cadastral Liegenschaft and
Selbstrecht collections from the existing metadata catalog and makes up to two
bounded OGC feature queries (25 candidates per collection). It joins details
only by an E-GRID already returned by OEREB, preserving the complete original
choice list. Other nearby OGC features do not become additional choices.
`choices` includes `propertyType`, `section`, `parcelNumber`, `label`, `detailStatus`
and `detailSource`. For example, exact source labels can distinguish
`Liegenschaft.Liegenschaft`, `SelbstRecht.Baurecht.Baurecht` and
`SelbstRecht.Baurecht.UnterBaurecht`. The OEREB response alone may call both of
the latter simply `BuildingRight`/Baurecht.

If details are missing, conflicting, unavailable or not reached within the
bounded query, the choice remains with its original OEREB type and an explicit
`detailStatus: unavailable`; no detailed type or section is invented. There is
no automatic fallback selection. A single distinct E-GRID skips this enrichment
and proceeds directly to its JSON extract.

Extract requests always include **`extended=true`**. A successful response has
`status: extract_available`, the exact E-GRID, source URL and retrieval time,
resolution details, the complete JSON supplied by the service in `response`,
and an official PDF URL that has not been fetched. Unknown extension fields,
legal provisions, status, disclaimers and dates are preserved.

`CreationDate` is the extract creation date. `UpdateDateCS` concerns cadastral
surveying; neither is the update date of every restriction. Preserve original
dates and do not invent a timezone or infer legal effect from JSON/PDF format.
An extract is not a complete legal dossier or permission to build.

The JSON does **not necessarily include the extended PDF's Annex A**. In a
checked example, enabling the extended PDF added Annex A while the JSON's
substantive content remained unchanged. Refer to the official extended PDF when
these additional details are needed; do not invent a machine-readable annex.

## Official PDF link: `get_oereb_pdf_link`

Only on an explicit PDF request, pass a known E-GRID:

```json
{ "egrid": "CH516702897010" }
```

The result provides `status: link_available` and an official URL of the form:

```text
https://api.oereb.bs.ch/extract/pdf/?EGRID=CH516702897010&extended=true
```

Opening the link asks the official service to generate the extended document.
Generation may take tens of seconds and the document can be several megabytes.
The MCP server neither downloads nor attaches, validates or caches a file.
`downloaded: false` and `egridVerified: false` describe this tool's own work:
it validates identifier format, not existence. Prefer an E-GRID confirmed by
an extract or property lookup. The returned URL alone does not prove an
available, current or legally sufficient document.

## Limits and operation

OEREB JSON calls use the existing bounded HTTP machinery with a dedicated fixed
HTTPS origin and no custom headers. Redirects are rejected and GeoBS API keys
are never forwarded. Empty HTTP 204 is a no-result response; HTML, malformed JSON,
unexpected structures and a mismatched extract E-GRID are rejected.

The default upstream timeout is 15 seconds and the JSON input limit is 2 MB.
The 250 KB MCP result limit counts both the text and structured representations.
A large extract or candidate list fails explicitly with `RESPONSE_TOO_LARGE`
and an official source URL; no fields or choices are silently removed to claim
a complete result. Narrow the property lookup or use the official source.

Allow outbound HTTPS and DNS access to `api.oereb.bs.ch` before deploying on a
restricted network. Existing GeoBS endpoints and their key configuration are
unchanged. The direct PDF URL is fetched by the user's browser, not this server.
Refresh client tool lists after deploying the additional tools.

References:

- [Basel-Stadt OEREB service and examples](https://www.bs.ch/fr/node/29741)
- [Official OEREB portal](https://oereb.bs.ch/)
- [Federal OEREB Webservice directive, section 3.1](https://www.cadastre-manual.admin.ch/dam/de/sd-web/WqC3xqprX0KA/Weisung-OEREB-XML-Aufruf-de.pdf)
