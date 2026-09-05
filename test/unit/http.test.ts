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

  it.each([undefined, "1"])(
    "cancels an oversized stream with content-length %s before reading the remaining chunks",
    async (declaredLength) => {
      const cancel = vi.fn();
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new TextEncoder().encode("x".repeat(16)));
      });
      const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
      const headers = declaredLength ? { "content-length": declaredLength } : undefined;
      const fetcher = vi.fn(async () => new Response(body, { headers }));

      await expect(fetchJson("https://api.geo.bs.ch/stac/v1/collections", {
        fetcher, maxBytes: 20
      })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
      expect(pull).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
    }
  );

  it("cancels a declared oversized response without reading its body", async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const fetcher = vi.fn(async () => new Response(body, {
      headers: { "content-length": "21" }
    }));
    await expect(fetchJson("https://api.geo.bs.ch/stac/v1/collections", {
      fetcher, maxBytes: 20
    })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("decodes a multibyte character split between chunks at the exact byte limit", async () => {
    const value = { name: "Bäume" };
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const body = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      }
    });
    const fetcher = vi.fn(async () => new Response(body));
    const result = await fetchJson("https://api.geo.bs.ch/stac/v1/collections", {
      fetcher, maxBytes: bytes.byteLength
    });
    expect(result.data).toEqual(value);
  });

  it("maps a timeout while reading the response body", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new TypeError("terminated"));
          }, { once: true });
        }
      }))
    );
    await expect(fetchJson("https://api.geo.bs.ch/stac/v1/collections", {
      fetcher, timeoutMs: 5
    })).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
  });
});
