import { LIMITS } from "../config";
import { GeoBsError } from "../errors";

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function buildResult(summary: string, output: Record<string, unknown>) {
  // Normalize undefined once, so text-only clients and structured clients see
  // exactly the same JSON, including every identifier needed for follow-up calls.
  const text = JSON.stringify(output);
  const structuredContent = JSON.parse(text) as Record<string, unknown>;
  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "text" as const, text }
    ],
    structuredContent
  };
}

export function fitsToolOutput(output: Record<string, unknown>, summary = ""): boolean {
  return jsonByteLength(buildResult(summary, output)) <= LIMITS.maxToolOutputBytes;
}

export function successResult(summary: string, output: Record<string, unknown>) {
  const result = buildResult(summary, output);
  // Every tool passes this final check, including tools without a reduction policy.
  // Count the full result: summary, JSON text, structured content and wrapper keys.
  if (jsonByteLength(result) > LIMITS.maxToolOutputBytes) {
    throw new GeoBsError(
      "RESPONSE_TOO_LARGE",
      "The tool response exceeds the output limit. Request fewer results or properties."
    );
  }
  return result;
}
