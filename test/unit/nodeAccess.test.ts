import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWK } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { accessConfiguration, createAccessGuard } from "../../src/node/access";
import { nodeConfig } from "../../src/node/config";
import { createNodeServer } from "../../src/node/http";
import { createCatalogSnapshot } from "../../src/catalog";

const issuer = "https://test-team.cloudflareaccess.com";
const audience = "a".repeat(64);
const env = { GEOBS_AUTH_MODE: "cloudflare-access", GEOBS_ACCESS_ISSUER: issuer,
  GEOBS_ACCESS_AUDIENCE: audience, GEOBS_OAUTH_RESOURCE: "https://geo.example.test/mcp",
  GEOBS_OAUTH_AUTHORIZATION_SERVER: "https://geo.example.test/" };
const config = accessConfiguration(env)!;
let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwk: JWK;
const apps: ReturnType<typeof createNodeServer>[] = [];
const realFetch = globalThis.fetch;
let keyFetches = 0;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: "current", alg: "RS256", use: "sig" };
});
afterEach(async () => {
  for (const app of apps.splice(0)) if (app.server.listening) await app.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function keys(available = true) {
  keyFetches = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) === `${issuer}/cdn-cgi/access/certs`) {
      keyFetches++;
      expect(init?.redirect).toBe("manual");
      return available ? Response.json({ keys: [jwk] }) : new Response("unavailable", { status: 503 });
    }
    return realFetch(input, init);
  });
}

async function token(changes: JWTPayload = {}, omit: string[] = [], key = signingKey, kid = "current", header: { typ?: string } = { typ: "JWT" }) {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = { iss: issuer, aud: [audience], sub: "synthetic-user", email: "person@example.test",
    type: "app", iat: now, nbf: now, exp: now + 300, ...changes };
  for (const name of omit) delete payload[name];
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid, ...header }).sign(key);
}

async function fixture(basePath = "") {
  const snapshot = await createCatalogSnapshot([{ id: "ch.bs.strassennamen_stna", title: "Strassennamen" }]);
  const logs: Record<string, unknown>[] = [];
  const catalog = { get: vi.fn(async () => snapshot) };
  const hosts = ["geo.example.test"];
  const access = { ...config, resource: `https://geo.example.test${basePath}/mcp` };
  const app = createNodeServer({ hosts, origins: ["https://geo.example.test"], publicBasePath: basePath,
    catalog, log: event => logs.push(event), access });
  apps.push(app);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const { port } = app.server.address() as { port: number };
  hosts.push(`127.0.0.1:${port}`);
  return { app, logs, catalog, port, base: `http://127.0.0.1:${port}` };
}
const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const rpcHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("Access configuration fails closed", () => {
  it("preserves the explicit anonymous runtime when no auth settings are supplied", () => {
    expect(nodeConfig({}).access).toBeUndefined();
    expect(nodeConfig(env).access).toEqual(config);
    expect(accessConfiguration({ ...env, GEOBS_OAUTH_AUTHORIZATION_SERVER: "https://geo.example.test" })?.authorizationServer)
      .toBe("https://geo.example.test");
  });
  it.each(Object.keys(env).filter(name => name !== "GEOBS_AUTH_MODE"))("requires %s", name => {
    const partial: Record<string, string> = { ...env };
    delete partial[name];
    expect(() => accessConfiguration(partial)).toThrow();
  });
  it("does not fall back to anonymous on mode typos or incomplete auth configuration", () => {
    expect(() => accessConfiguration({ ...env, GEOBS_AUTH_MODE: "cloudflare-acces" })).toThrow();
    expect(() => accessConfiguration({ ...env, GEOBS_AUTH_MODE: "none" })).toThrow();
    expect(() => accessConfiguration({ GEOBS_ACCESS_AUDIENCE: audience })).toThrow();
  });
  it.each(["http://test-team.cloudflareaccess.com", `${issuer}/`, "https://evil.example.test", `${issuer}:8443`, `${issuer}@evil.example.test`])("rejects issuer %s", value => {
    expect(() => accessConfiguration({ ...env, GEOBS_ACCESS_ISSUER: value })).toThrow();
  });
  it.each(["http://geo.example.test/mcp", "https://user:pass@geo.example.test/mcp", "https://geo.example.test/mcp?token=secret", "https://geo.example.test/mcp#fragment", "https://geo.example.test/docs"])("rejects resource %s", value => {
    expect(() => accessConfiguration({ ...env, GEOBS_OAUTH_RESOURCE: value })).toThrow();
  });
  it.each(["0", "59", "901", "3600", "-1", "5m", "Infinity"])("bounds assertion lifetime %s", value => {
    expect(() => accessConfiguration({ ...env, GEOBS_ACCESS_MAX_TOKEN_LIFETIME_SECONDS: value })).toThrow();
  });
});

describe("signed personal Access assertion", () => {
  it("validates a dedicated application token and caches only public verification keys", async () => {
    keys();
    const guard = createAccessGuard(config);
    expect(await guard.accepts(await token())).toBe(true);
    expect(await guard.accepts(await token())).toBe(true);
    expect(keyFetches).toBe(1);
  });
  it.each([{}, { typ: "JWT" }, { typ: "jwt" }, { typ: "application/jwt" }])("accepts an optional JWT type header %j", async header => {
    keys();
    expect(await createAccessGuard(config).verify(await token({}, [], signingKey, "current", header))).toEqual({ ok: true });
  });
  it.each(["at+jwt", "org", "", " JWT", "application/jwt;other"])("rejects an explicit unexpected type header %j", async typ => {
    keys();
    expect(await createAccessGuard(config).verify(await token({}, [], signingKey, "current", { typ })))
      .toEqual({ ok: false, reason: "claims", claim: "typ", claim_issue: "invalid" });
  });
  it("keeps signature, audience, identity and required time claims mandatory without a type header", async () => {
    keys();
    const guard = createAccessGuard(config);
    const noType = (changes: JWTPayload = {}, omit: string[] = [], key = signingKey) => token(changes, omit, key, "current", {});
    for (const signed of [await noType({}, [], otherKey), await noType({ aud: ["b".repeat(64)] }),
      await noType({ iss: "https://other.cloudflareaccess.com" }), await noType({ type: "org" }),
      await noType({ sub: "" }), await noType({ email: "" }), await noType({ nbf: 4_000_000_000 }),
      await noType({ exp: 1 }), ...await Promise.all(["exp", "iat", "nbf", "sub", "email", "type"].map(claim => noType({}, [claim])))]) {
      expect((await guard.verify(signed)).ok).toBe(false);
    }
  });
  it.each([
    { name: "issuer", reason: "issuer", changes: { iss: "https://other.cloudflareaccess.com" } },
    { name: "audience", reason: "audience", changes: { aud: ["b".repeat(64)] } },
    { name: "expired", reason: "expired", changes: { iat: 1, nbf: 1, exp: 2 } },
    { name: "not yet valid", reason: "not_yet_valid", changes: { nbf: 4_000_000_000 } },
    { name: "future issue time", reason: "not_yet_valid", changes: { iat: 4_000_000_000, exp: 4_000_000_300 } },
    { name: "org session", reason: "token_type", changes: { type: "org" } },
    { name: "empty subject", reason: "identity", changes: { sub: "" } },
    { name: "service identity", reason: "identity", changes: { email: "" } },
    { name: "long lifetime", reason: "lifetime", changes: { exp: Math.floor(Date.now() / 1000) + 3600 } }
  ])("rejects $name with reason $reason", async ({ changes, reason }) => {
    keys();
    const guard = createAccessGuard(config);
    const signed = await token(changes);
    expect(await guard.accepts(signed)).toBe(false);
    expect(await guard.verify(signed)).toMatchObject({ ok: false, reason });
  });
  it.each(["exp", "iat", "nbf", "sub", "email", "type"])("requires claim %s", async claim => {
    keys();
    const guard = createAccessGuard(config);
    const signed = await token({}, [claim]);
    expect(await guard.accepts(signed)).toBe(false);
    expect(await guard.verify(signed)).toEqual({ ok: false, reason: "claims", claim, claim_issue: "missing" });
  });
  it("names the refusal without exposing token content", async () => {
    keys();
    const guard = createAccessGuard(config);
    const valid = await token();
    expect(await guard.verify(valid)).toEqual({ ok: true });
    expect(await guard.verify(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(await guard.verify("")).toEqual({ ok: false, reason: "missing" });
    expect(await guard.verify("oauth:opaque-token")).toEqual({ ok: false, reason: "malformed" });
    expect(await guard.verify(`${valid}, ${valid}`)).toEqual({ ok: false, reason: "malformed" });
    expect(await guard.verify(await token({}, [], otherKey))).toEqual({ ok: false, reason: "signature" });
    expect(await guard.verify(await token({}, [], signingKey, "unknown"))).toEqual({ ok: false, reason: "unknown_key" });
    expect(await guard.verify(`${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.x`))
      .toEqual({ ok: false, reason: "malformed" });
    keys(false);
    expect(await createAccessGuard(config).verify(valid)).toEqual({ ok: false, reason: "keys_unavailable" });
  });
  it("reports only fixed claim diagnostics through HTTP, never claim values or library errors", async () => {
    keys();
    const { base, logs, catalog } = await fixture();
    for (const [signed, claim, issue] of [
      [await token({}, ["nbf"]), "nbf", "missing"],
      [await token({ nbf: "private-claim-value" as unknown as number }), "nbf", "invalid"],
      [await token({ nbf: 4_000_000_000 }), "nbf", "check_failed"],
      [await token({ aud: ["b".repeat(64)] }), "aud", "check_failed"]
    ]) {
      logs.length = 0;
      const response = await fetch(`${base}/mcp`, { method: "POST", body: rpc,
        headers: { ...rpcHeaders, "cf-access-jwt-assertion": signed! } });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "access_assertion_rejected" });
      expect(logs.find(event => event.event === "access_denied")).toMatchObject({ claim, claim_issue: issue });
      expect(JSON.stringify(logs)).not.toMatch(/private-claim-value|person@example|synthetic-user|eyJ|JWTClaimValidationFailed/);
      expect(JSON.stringify(logs)).not.toContain(signed);
    }
    expect(catalog.get).not.toHaveBeenCalled();
  });
  it("rejects forged signatures, unknown key IDs, alg=none, oversized and duplicated assertions", async () => {
    keys();
    const guard = createAccessGuard(config);
    const valid = await token();
    for (const invalid of [undefined, "", "not-a-jwt", "oauth:opaque-token", "x".repeat(12001), `${valid}, ${valid}`,
      await token({}, [], otherKey), await token({}, [], signingKey, "unknown"),
      `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{}').toString("base64url")}.x`]) {
      expect(await guard.accepts(invalid)).toBe(false);
    }
    expect(keyFetches).toBe(1);
  });
  it("fails closed when the verification key endpoint is unavailable", async () => {
    keys(false);
    expect(await createAccessGuard(config).accepts(await token())).toBe(false);
  });
  it("rejects a previously accepted assertion after expiry, without a cached authorization result", async () => {
    keys();
    vi.useFakeTimers({ toFake: ["Date"] });
    const guard = createAccessGuard(config);
    const signed = await token();
    expect(await guard.accepts(signed)).toBe(true);
    vi.setSystemTime(Date.now() + 306_000);
    expect(await guard.accepts(signed)).toBe(false);
  });
});

describe("OAuth-protected Node HTTP boundary", () => {
  it.each(["", "/geobs-mcp/v1"])("protects every MCP method and alias under prefix %j before buffering/dispatch", async prefix => {
    keys();
    const { base, logs, catalog } = await fixture(prefix);
    const paths = [...new Set(["/mcp", `${prefix}/mcp`])];
    for (const path of paths) {
      for (const method of ["POST", "GET", "DELETE", "HEAD", "PUT"]) {
        const response = await fetch(`${base}${path}`, { method, headers: rpcHeaders,
          ...(method === "POST" || method === "PUT" ? { body: rpc } : {}) });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="https://geo.example.test/.well-known/oauth-protected-resource${prefix}/mcp"`);
      }
    }
    expect(catalog.get).not.toHaveBeenCalled();
    expect(logs.every(event => event.event !== "mcp_tool")).toBe(true);
    expect(keyFetches).toBe(0);
  });
  it("rejects bearer/cookie/header impersonation and never logs identity or credentials", async () => {
    keys();
    const { base, logs } = await fixture();
    const signed = await token();
    const impersonations: Record<string, string>[] = [
      { authorization: `Bearer ${signed}` },
      { cookie: `CF_Authorization=${signed}` },
      { "cf-access-authenticated-user-email": "person@example.test", "x-forwarded-user": "synthetic-user" }
    ];
    for (const headers of impersonations) {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers: { ...rpcHeaders, ...headers }, body: rpc });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    }
    const forged = await fetch(`${base}/mcp`, { method: "POST", body: rpc,
      headers: { ...rpcHeaders, "cf-access-jwt-assertion": "forged", "x-forwarded-host": "geo.example.test" } });
    expect(forged.status).toBe(403);
    expect(JSON.stringify(logs)).not.toMatch(/person@example|synthetic-user|eyJ|forged/);
  });
  it("answers a refused gateway assertion with 403 and a reason code instead of a new login challenge", async () => {
    keys();
    const { base, logs, catalog } = await fixture("/geobs-mcp/v1");
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, string][] = [
      ["lifetime", await token({ exp: now + 86_400 })],
      ["audience", await token({ aud: ["b".repeat(64)] })],
      ["signature", await token({}, [], otherKey)],
      ["token_type", await token({ type: "org" })]
    ];
    for (const [reason, assertion] of cases) {
      logs.length = 0;
      const response = await fetch(`${base}/geobs-mcp/v1/mcp`, { method: "POST", body: rpc,
        headers: { ...rpcHeaders, origin: "https://geo.example.test", authorization: "Bearer oauth:opaque", "cf-access-jwt-assertion": assertion } });
      expect(response.status).toBe(403);
      // A 401 or challenge here would make clients drop a valid grant and loop through login.
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(response.headers.get("access-control-allow-origin")).toBe("https://geo.example.test");
      expect(await response.json()).toEqual({ error: "access_assertion_rejected" });
      expect(logs.filter(event => event.event === "access_denied").map(event => event.reason)).toEqual([reason]);
      expect(logs.find(event => event.event === "http_request")).toMatchObject({ route: "mcp", status: 403 });
      expect(JSON.stringify(logs)).not.toMatch(/person@example|synthetic-user|eyJ|oauth:opaque/);
    }
    logs.length = 0;
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: rpcHeaders, body: rpc })).status).toBe(401);
    expect(logs.filter(event => event.event === "access_denied").map(event => event.reason)).toEqual(["missing"]);
    expect(catalog.get).not.toHaveBeenCalled();
    expect(logs.every(event => event.event !== "mcp_tool")).toBe(true);
  });
  it.each(["legacy", "auto"] as const)("retains five tools and cache search for authenticated %s clients", async mode => {
    keys();
    const { base, logs } = await fixture();
    const signed = await token({}, [], signingKey, "current", {});
    const client = new Client({ name: "synthetic-oauth-test", version: "1" }, { versionNegotiation: { mode } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { "cf-access-jwt-assertion": signed } }
    }));
    try {
      expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual([
        "get_dataset_stac", "get_property_info", "query_features_ogc", "search_api_v2", "search_datasets_ogc"
      ]);
      expect((await client.callTool({ name: "search_datasets_ogc", arguments: { query: "Strassennamen" } })).isError).not.toBe(true);
      expect(logs.some(event => event.event === "mcp_tool")).toBe(true);
      expect(JSON.stringify(logs)).not.toContain(signed);
      expect(JSON.stringify(logs)).not.toContain("person@example.test");
    } finally { await client.close(); }
  });
  it("leaves only documented metadata/docs/health/preflight routes public; Swagger describes OAuth", async () => {
    const { base, catalog } = await fixture("/geobs-mcp/v1");
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/geobs-mcp/v1/mcp"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resource: "https://geo.example.test/geobs-mcp/v1/mcp", authorization_servers: ["https://geo.example.test/"] });
    }
    expect(catalog.get).not.toHaveBeenCalled();
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    expect((await fetch(`${base}/docs`)).status).toBe(200);
    const spec = await (await fetch(`${base}/openapi.json`)).json() as {
      security: unknown; paths: Record<string, { post: { description: string; responses: Record<string, unknown> } }>
    };
    expect(spec.security).toEqual([{ personalOAuth: [] }]);
    expect(spec.paths["/mcp"]!.post.description).not.toContain("No bearer token");
    expect(spec.paths["/mcp"]!.post.responses["401"]).toBeDefined();
    expect(spec.paths["/mcp"]!.post.responses["403"]).toBeDefined();
    expect((await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://geo.example.test" } })).status).toBe(204);
    expect((await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://evil.example.test" } })).status).toBe(403);
    expect((await fetch(`${base}/.well-known/oauth-authorization-server`)).status).toBe(404);
  });
  it("still rejects wrong Hosts and Origins even with a valid signed identity", async () => {
    keys();
    const { base, port } = await fixture();
    const signed = await token();
    expect((await fetch(`${base}/mcp`, { headers: { "cf-access-jwt-assertion": signed, origin: "null" } })).status).toBe(403);
    const status = await new Promise<number>(resolve => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp", headers: {
        host: "evil.example.test", "x-forwarded-host": "geo.example.test", "cf-access-jwt-assertion": signed
      } }, response => { response.resume(); resolve(response.statusCode!); });
      req.end();
    });
    expect(status).toBe(403);
    expect(keyFetches).toBe(0);
  });
});
