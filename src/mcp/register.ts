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

interface ReadOnlyTool<Input extends Shape, Output extends Record<string, unknown>> {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  outputSchema: Shape;
  execute: (input: z.output<z.ZodObject<Input>>) => Promise<Output>;
  summarize: (output: Output) => string;
}

export function registerReadOnlyTool<
  Input extends Shape,
  Output extends Record<string, unknown>
>(server: McpServer, tool: ReadOnlyTool<Input, Output>) {
  const { name, execute, summarize, ...metadata } = tool;
  server.registerTool(name, {
    ...metadata,
    inputSchema: z.object(tool.inputSchema),
    outputSchema: z.object(tool.outputSchema).catchall(z.json()),
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
}
