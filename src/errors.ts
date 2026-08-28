export type GeoBsErrorCode =
  | "INVALID_INPUT"
  | "NO_RESULTS"
  | "DATASET_NOT_FOUND"
  | "COLLECTION_NOT_FOUND"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_REJECTED"
  | "UPSTREAM_AUTH_ERROR"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "INVALID_UPSTREAM_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "MISSING_API_KEY";

export class GeoBsError extends Error {
  readonly code: GeoBsErrorCode;
  readonly retryable: boolean;

  constructor(code: GeoBsErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "GeoBsError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function asGeoBsError(error: unknown): GeoBsError {
  if (error instanceof GeoBsError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ZodError"
  ) {
    return new GeoBsError(
      "INVALID_INPUT",
      "The tool input does not match the required schema."
    );
  }
  return new GeoBsError(
    "UPSTREAM_UNAVAILABLE",
    "The GeoBS service request failed unexpectedly.",
    true
  );
}

export function errorResult(error: unknown) {
  const safe = asGeoBsError(error);
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: safe.code,
          message: safe.message,
          retryable: safe.retryable
        })
      }
    ]
  };
}
