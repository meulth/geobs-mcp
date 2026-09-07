import { describe, expect, it } from "vitest";
import { propertyNameSchema } from "../../src/schemas";

describe("property-name Unicode validation behind a portable MCP schema", () => {
  it.each(["Gebäudehöhe", "strasse_name", "Fläche m2", "foo.bar-1", "面積", "𐐀".repeat(100)])("accepts valid field %s", value => {
    expect(propertyNameSchema.parse(` ${value} `)).toBe(value);
  });
  it.each(["", " ", "x".repeat(101), "𐐀".repeat(101), "name&limit=100", "foo/bar", "a\nb", "name;drop", "*"])("rejects invalid field %s", value => {
    expect(propertyNameSchema.safeParse(value).success).toBe(false);
  });
});
