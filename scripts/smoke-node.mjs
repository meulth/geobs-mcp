import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Run only against the local compiled artifact, using public-shaped synthetic
// metadata. No upstream request or real credential is needed for this smoke test.
const release = resolve(process.argv.slice(2).find(value => !value.startsWith("--")) ?? "dist/node");
const prefix = join(tmpdir(), "geobs-bundle-test-");
const temporary = await mkdtemp(prefix);
const catalog = join(temporary, "catalog.json");
const collections = [{ id: "ch.bs.demo_stna", title: "Demo" }];
await writeFile(catalog, JSON.stringify({ schemaVersion: 1, source: "https://api.geo.bs.ch/ogc/v1/wfs3/collections?f=json", fetchedAt: new Date().toISOString(), collectionCount: 1, collections, contentHash: createHash("sha256").update(JSON.stringify(collections)).digest("hex") }));
const child = spawn(process.execPath, [join(release, "server.mjs")], {
  cwd: temporary, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { SystemRoot: process.env.SystemRoot, GEOBS_CATALOG_PATH: catalog, GEOBS_ALLOWED_HOSTS: "127.0.0.1:8080", GEOBS_ALLOWED_ORIGINS: "http://127.0.0.1:8080",
    ...(process.argv.includes("--access") ? { GEOBS_AUTH_MODE: "cloudflare-access", GEOBS_ACCESS_ISSUER: "https://synthetic-team.cloudflareaccess.com",
      GEOBS_ACCESS_AUDIENCE: "a".repeat(64), GEOBS_OAUTH_RESOURCE: "https://geo.example.test/mcp",
      GEOBS_OAUTH_AUTHORIZATION_SERVER: "https://geo.example.test" } : {}) }
});
let output = "";
let errors = "";
child.stdout.on("data", chunk => { output += chunk; });
child.stderr.on("data", chunk => { errors += chunk; });
const deadline = setTimeout(() => child.kill(), 15_000);
try {
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`Compiled server exited before readiness. ${errors.slice(0, 300)}`)));
    child.stdout.on("data", () => { if (output.includes('"server_started"')) resolve(); });
  });
  for (const route of ["live", "ready"]) {
    const response = await fetch(`http://127.0.0.1:8080/health/${route}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  }
  const spec = await (await fetch("http://127.0.0.1:8080/openapi.json")).json();
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(Object.keys(spec.paths["/mcp"].post.requestBody.content["application/json"].examples).length, 7);
  for (const asset of ["swagger-ui-bundle.js", "swagger-ui.css", "swagger-initializer.js"]) {
    const response = await fetch(`http://127.0.0.1:8080/docs/${asset}`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 100);
  }
  if (process.argv.includes("--access")) {
    const response = await fetch("http://127.0.0.1:8080/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), 'Bearer resource_metadata="https://geo.example.test/.well-known/oauth-protected-resource/mcp"');
    // A refused assertion is not a login problem: no second OAuth challenge.
    const refused = await fetch("http://127.0.0.1:8080/mcp", { method: "POST", headers: { "cf-access-jwt-assertion": "a.b.c" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get("www-authenticate"), null);
    assert.match(output, /"event":"access_denied"/);
    const metadata = await (await fetch("http://127.0.0.1:8080/.well-known/oauth-protected-resource/mcp")).json();
    assert.equal(metadata.resource, "https://geo.example.test/mcp");
    assert.deepEqual(metadata.authorization_servers, ["https://geo.example.test"]);
    assert.deepEqual(spec.security, [{ personalOAuth: [] }]);
    assert.ok(!output.includes('"mcp_tool"'));
    console.log(JSON.stringify({ result: "passed", artifact: release, node: process.versions.node,
      checks: ["compiled Access configuration", "anonymous MCP rejection", "refused assertion without login loop", "OAuth challenge and public metadata", "local health/readiness", "public OAuth-aware Swagger"] }));
  } else {
    const legacy = await fetch("http://127.0.0.1:8080/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.match(legacy.headers.get("content-type"), /text\/event-stream/);
    assert.match(await legacy.text(), /query_features_ogc/);
    const client = new Client({ name: "bundle-smoke", version: "1" }, { versionNegotiation: { mode: "auto" } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8080/mcp")));
      assert.equal(client.getProtocolEra(), "modern");
      assert.equal((await client.listTools()).tools.length, 5);
      const result = await client.callTool({ name: "search_datasets_ogc", arguments: { query: "Demo" } });
      assert.equal(result.structuredContent.resultCount, 1);
      assert.match(JSON.stringify(result.content), /ch\.bs\.demo_stna/);
    } finally { await client.close(); }
    console.log(JSON.stringify({ result: "passed", artifact: release, node: process.versions.node, checks: ["compiled startup", "local health/readiness", "OpenAPI 3.1 and local Swagger assets", "legacy SSE", "modern JSON", "five tools", "catalog search", "text and structuredContent"] }));
  }
} finally {
  clearTimeout(deadline);
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  if (!temporary.startsWith(prefix)) throw new Error("Unexpected cleanup path");
  await rm(temporary, { recursive: true, force: true });
}
