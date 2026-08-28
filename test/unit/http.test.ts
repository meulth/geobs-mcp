import { describe, expect, it, vi } from "vitest";
import { GeoBsError } from "../../src/errors";
import { fetchJson } from "../../src/http";

describe("fetchJson", () => {
  it("rejects non-GeoBS origins", async () => {
    await expect(fetchJson("https://example.com/data")).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
  });

  it("maps rate limits without exposing response bodies", async () => {
    const fetcher = vi.fn(async () => new Response("secret upstream detail", { status: 429 }));
    await expect(
      fetchJson("https://api.geo.bs.ch/stac/v1/collections", { fetcher })
    ).rejects.toMatchObject({ code: "RATE_LIMIT", retryable: true });
  });

  it("enforces the response byte limit", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ data: "x".repeat(100) }), {
        headers: { "content-type": "application/json" }
      })
    );
    await expect(
      fetchJson("https://api.geo.bs.ch/stac/v1/collections", {
        fetcher,
        maxBytes: 20
      })
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("maps AbortController timeouts", async () => {
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        })
    );
    await expect(
      fetchJson("https://api.geo.bs.ch/stac/v1/collections", {
        fetcher,
        timeoutMs: 5
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GeoBsError>>({ code: "TIMEOUT", retryable: true })
    );
  });

  it("maps invalid JSON", async () => {
    const fetcher = vi.fn(async () => new Response("not-json"));
    await expect(
      fetchJson("https://api.geo.bs.ch/stac/v1/collections", { fetcher })
    ).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });
});
