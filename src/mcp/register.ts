import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { asGeoBsError, errorResult } from "../errors";
import { jsonByteLength, successResult } from "./results";
import { elapsed, recordEvent } from "../telemetry";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

type Shape = Record<string, z.ZodType>;

// Documentation observes the very same schemas/metadata registered with MCP.
// A WeakMap avoids retaining the per-request stateless MCP server instances.
export interface ToolDocumentation {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<Shape>;
  outputSchema: z.ZodType;
  example: Record<string, unknown>;
}
const documentation = new WeakMap<McpServer, ToolDocumentation[]>();
export const getToolDocumentation = (server: McpServer): readonly ToolDocumentation[] => documentation.get(server) ?? [];

interface ReadOnlyTool<Input extends Shape, Output extends Record<string, unknown>> {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  outputSchema: Shape;
  example: z.input<z.ZodObject<Input>>;
  execute: (input: z.output<z.ZodObject<Input>>) => Promise<Output>;
  summarize: (output: Output) => string;
}

export function registerReadOnlyTool<
  Input extends Shape,
  Output extends Record<string, unknown>
>(server: McpServer, tool: ReadOnlyTool<Input, Output>) {
  const { name, execute, summarize, example, ...metadata } = tool;
  const inputSchema = z.object(tool.inputSchema);
  const outputSchema = z.object(tool.outputSchema).catchall(z.json());
  server.registerTool(name, {
    ...metadata,
    inputSchema,
    outputSchema,
    annotations: READ_ONLY
  }, async (input) => {
    const start = performance.now();
    try {
      const output = await execute(input);
      const result = successResult(summarize(output), output);
      recordEvent({ event: "mcp_tool", tool: name, outcome: "success",
        duration_ms: elapsed(start), output_bytes: jsonByteLength(result) });
      return result;
    } catch (error) {
      recordEvent({ event: "mcp_tool", tool: name, outcome: "error",
        duration_ms: elapsed(start), error_code: asGeoBsError(error).code });
      return errorResult(error);
    }
  });
  const tools = documentation.get(server) ?? [];
  tools.push({ name, title: tool.title, description: tool.description, inputSchema, outputSchema, example });
  documentation.set(server, tools);
}
