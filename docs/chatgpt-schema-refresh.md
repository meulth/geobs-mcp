# MCP schema compatibility

A tool can work in one MCP client while another rejects its schema during tool
discovery. Direct tool execution does not establish importer compatibility.

## Fixed-length arrays

Bounding boxes publish homogeneous numeric arrays with `items`,
`minItems: 4` and `maxItems: 4`. Tuple schemas based on `prefixItems` can be
incompatible with clients that expect `items`.
Runtime validation still rejects incorrect lengths and nonnumeric coordinates.

## Unicode field names

JSON Schema patterns do not carry JavaScript regular-expression flags separately.
The project's Unicode field-name checks therefore run in a Zod refinement.
Published schemas contain portable length constraints and a description:

```json
{
  "type": "string",
  "minLength": 1,
  "maxLength": 100,
  "description": "Field name: letters, numbers, spaces, dots, underscores or hyphens; validated by the server."
}
```

The server still validates Unicode letters/numbers, including non-Latin
characters, and rejects disallowed punctuation. Removing an incompatible
published pattern does not disable input validation.

## Verification

The MCP tests inspect actual `tools/list` schemas, annotations and JSON text
results, including their use in subsequent calls. Field-name tests exercise
Unicode and length boundaries. They do not implement a client's private importer.

After changing tool names or schemas, refresh the existing connection in each
MCP client. Confirm the expected tool names are visible and exercise a bounded
call. Client-side cached metadata and runtime server errors are separate issues.

Sources:
[JSON Schema regular expressions](https://json-schema.org/understanding-json-schema/reference/regular_expressions),
[Zod JSON Schema](https://zod.dev/json-schema),
[OpenAI connection metadata](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
