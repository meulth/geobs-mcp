import { z } from "zod";
import { LIMITS } from "./config";

export const datasetIdSchema = z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/);
export const collectionIdSchema = z.string().trim().regex(/^[A-Za-z0-9._-]{1,300}$/);
export const propertyIdSchema = z.string().trim().regex(/^[A-Za-z0-9-]{2,40}$/);
export const locationQuerySchema = z.string().trim().min(2).max(200);
export const propertyNameSchema = z.string().trim().regex(/^[\p{L}\p{N} _.-]{1,100}$/u);
export const propertyValueSchema = z.union([
  z.string().max(200), z.number().finite(), z.boolean()
]);
export const outputPropertiesSchema = z.array(propertyNameSchema).max(30);
export const propertyIdsSchema = z.array(propertyIdSchema).min(1).max(LIMITS.maxPropertyIds);
// Homogeneous fixed-length arrays publish `items` + min/maxItems. Zod tuples
// publish `prefixItems`, which some MCP tool importers cannot consume.
export const bboxSchema = z.array(z.number().finite()).length(4)
  .describe("Bounding box [minX, minY, maxX, maxY], exactly four finite numbers.");

export const epsgSchema = z.union([
  z.literal(2056),
  z.literal(4326),
  z.literal(3857),
  z.literal(4258)
]);

export const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  epsg: epsgSchema.default(2056)
});

export const propertyFilterSchema = z.object({
  property: propertyNameSchema,
  value: propertyValueSchema
});
export const propertyFiltersSchema = z.array(propertyFilterSchema).max(LIMITS.maxPropertyFilters);
