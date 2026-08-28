import { z } from "zod";
import { SEARCH_TYPES } from "../clients/search";
import { LIMITS } from "../config";

export const epsgSchema = z.union([
  z.literal(2056),
  z.literal(4326),
  z.literal(3857),
  z.literal(4258)
]);

export const searchLocationShape = {
  query: z.string().trim().min(2).max(200).describe("Address, street, place or other location search text."),
  limit: z.number().int().min(1).max(LIMITS.maxSearchResults).default(8),
  epsg: z.union([z.literal(2056), z.literal(4326)]).default(2056),
  outputFormat: z.enum(["geom", "bbox", "centroid"]).default("geom"),
  types: z.array(z.enum(SEARCH_TYPES)).max(SEARCH_TYPES.length).optional()
};
export const searchLocationInput = z.object(searchLocationShape);

export const searchDatasetsShape = {
  query: z.string().trim().min(2).max(100).describe("German or English dataset topic, title or identifier."),
  limit: z.number().int().min(1).max(LIMITS.maxDatasetResults).default(8)
};
export const searchDatasetsInput = z.object(searchDatasetsShape);

export const getDatasetShape = {
  id: z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/).describe("Exact STAC collection ID returned by search_datasets.")
};
export const getDatasetInput = z.object(getDatasetShape);

export const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  epsg: epsgSchema.default(2056),
  radius: z.number().finite().min(0).optional()
});

export const propertyFilterSchema = z.object({
  property: z.string().trim().min(1).max(100),
  value: z.union([z.string().max(200), z.number().finite(), z.boolean()])
});

export const queryFeaturesShape = {
  collectionId: z.string().trim().regex(/^[A-Za-z0-9._-]{1,300}$/).describe("Exact OGC collection ID returned by get_dataset."),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  point: pointSchema.optional().describe("Point query; radius is expressed in units of the point CRS."),
  bboxEpsg: epsgSchema.default(2056),
  outputEpsg: epsgSchema.optional(),
  limit: z.number().int().min(1).max(LIMITS.maxFeatures).default(10),
  properties: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  filters: z.array(propertyFilterSchema).max(LIMITS.maxPropertyFilters).optional(),
  includeGeometry: z.boolean().default(true)
};
export const queryFeaturesInput = z.object(queryFeaturesShape);

export const getPropertyInfoShape = {
  ids: z.array(z.string().trim().regex(/^[A-Za-z0-9-]{2,40}$/)).min(1).max(LIMITS.maxPropertyIds).optional().describe("E-GRID or section/parcel IDs."),
  point: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    epsg: epsgSchema.default(2056)
  }).optional().describe("A point, normally copied from search_location."),
  withGeometry: z.boolean().default(false)
};
export const getPropertyInfoInput = z.object(getPropertyInfoShape);

export const searchLocationOutputShape = {
  query: z.string(),
  crs: z.string(),
  resultCount: z.number().int(),
  results: z.array(
    z.object({
      label: z.string(),
      type: z.string(),
      geometry: z.string(),
      coordinate: z.tuple([z.number(), z.number()]).optional()
    }).catchall(z.json())
  )
};

export const searchDatasetsOutputShape = {
  query: z.string(),
  searchedCollectionCount: z.number().int(),
  resultCount: z.number().int(),
  datasets: z.array(
    z.object({ id: z.string(), title: z.string().optional() }).catchall(z.json())
  )
};

export const getDatasetOutputShape = {
  id: z.string(),
  title: z.string().optional(),
  items: z.array(z.object({ id: z.string() }).catchall(z.json())),
  ogcFeaturesDiscovery: z.object({
    totalMatches: z.number().int(),
    collections: z.array(z.object({ id: z.string() }).catchall(z.json()))
  }).catchall(z.json())
};

export const queryFeaturesOutputShape = {
  collection: z.object({ id: z.string() }).catchall(z.json()),
  crs: z.string(),
  numberReturned: z.number().int(),
  features: z.array(z.object({ id: z.union([z.string(), z.number()]).optional() }).catchall(z.json()))
};

export const getPropertyInfoOutputShape = {
  resolvedFrom: z.object({ type: z.enum(["ids", "point"]) }).catchall(z.json()),
  requestedIds: z.array(z.string()),
  realEstates: z.array(z.record(z.string(), z.json()))
};
