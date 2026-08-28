import { GeoBsError } from "../errors";
import { SearchClient, parsePointWkt } from "../clients/search";
import { searchLocationInput } from "./schemas";

export async function searchLocation(
  client: SearchClient,
  input: unknown
) {
  const parsed = searchLocationInput.parse(input);
  const results = await client.search(parsed.query, {
    limit: parsed.limit,
    epsg: parsed.epsg,
    outputFormat: parsed.outputFormat,
    types: parsed.types
  });
  if (results.length === 0) {
    throw new GeoBsError("NO_RESULTS", "No location matched the search term.");
  }

  return {
    query: parsed.query,
    crs: `EPSG:${parsed.epsg}`,
    resultCount: results.length,
    results: results.map((result) => ({
      label: result.label.trim(),
      type: result.layer_name,
      details: result.details ?? {},
      geometry: result.geom,
      coordinate: parsePointWkt(result.geom)
    }))
  };
}
