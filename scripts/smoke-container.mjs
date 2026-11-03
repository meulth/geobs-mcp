import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// An opt-in real Docker test. Only synthetic metadata, no key or upstream calls.
const image = process.argv[2] ?? "geobs-mcp:container-test";
const name = `geobs-mcp-smoke-${randomUUID()}`;
const prefix = join(tmpdir(), "geobs-container-test-");
const temporary = await mkdtemp(prefix);
await chmod(temporary, 0o755);
const docker = (...args) => execFileSync("docker", args, {
  encoding: "utf8", timeout: 30_000, windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
}).trim();
const toolNames = ["search_api_v2", "search_datasets_ogc", "get_dataset_stac", "query_features_ogc", "get_property_info"].sort();
// Native fetch does not reliably forward a caller-supplied Host. This local
// HTTP transport preserves it and buffers only our small finite test results.
const httpFetch = (input, init = {}) => new Promise((resolve, reject) => {
  const request = httpRequest(String(input), {
    method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)),
    signal: init.signal ?? AbortSignal.timeout(5_000)
  }, response => {
    const chunks = [];
    response.on("data", chunk => chunks.push(chunk));
    response.once("error", reject);
    response.once("end", () => resolve(new Response(
      [204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks),
      { status: response.statusCode, headers: response.headers }
    )));
  });
  request.once("error", reject);
  request.end(init.body);
});
let created = false;
try {
  docker("run", "--detach", "--name", name, "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m",
    "--publish", "127.0.0.1::8080", "--mount", `type=bind,source=${temporary},target=/fixtures,readonly`,
    "--env", "GEOBS_CATALOG_PATH=/fixtures/catalog.json", image);
  created = true;
  const publishedBase = () => {
    const ports = JSON.parse(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", name));
    const port = Number(ports["8080/tcp"][0].HostPort);
    assert.ok(Number.isInteger(port) && port > 0);
    return `http://127.0.0.1:${port}`;
  };
  let base = publishedBase();
  // The explicit authority is essential: the random published port is not
  // silently added to the application's strict Host allowlist.
  const localFetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "localhost:8080");
    return httpFetch(input, { ...init, headers });
  };
  async function waitForLive() {
    let last = "no response";
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await localFetch(`${base}/health/live`);
        if (response.status === 200) return;
        last = `HTTP ${response.status}`;
      } catch (error) { last = error.code ?? error.message; }
      await delay(100);
    }
    throw new Error(`Container did not become live: ${last}`);
  }
  await waitForLive();
  assert.deepEqual(await (await localFetch(`${base}/health/live`)).json(), { status: "ok" });
  assert.equal((await localFetch(`${base}/health/ready`)).status, 503);

  const collections = [{ id: "ch.bs.demo_stna", title: "Demo" }];
  await writeFile(join(temporary, "catalog.json"), JSON.stringify({
    schemaVersion: 1, source: "https://api.geo.bs.ch/ogc/v1/wfs3/collections?f=json",
    fetchedAt: new Date().toISOString(), collectionCount: 1, collections,
    contentHash: createHash("sha256").update(JSON.stringify(collections)).digest("hex")
  }), { mode: 0o644 });
  assert.equal((await localFetch(`${base}/health/ready`)).status, 200);
  assert.deepEqual(await (await localFetch(`${base}/health/ready`)).json(), { status: "ok" });
  assert.equal((await fetch(`${base}/mcp`)).status, 403);
  assert.equal((await localFetch(`${base}/mcp`, { headers: { origin: "https://foreign.example.test" } })).status, 403);

  for (const mode of ["auto", "legacy"]) {
    const types = [];
    const transportFetch = async (input, init) => {
      const response = await localFetch(input, init);
      types.push(response.headers.get("content-type") ?? "");
      return response;
    };
    const client = new Client({ name: "container-smoke", version: "1" }, { versionNegotiation: { mode } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { fetch: transportFetch }));
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), toolNames);
      const result = await client.callTool({ name: "search_datasets_ogc", arguments: { query: "Demo" } });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.resultCount, 1);
      assert.match(JSON.stringify(result.content), /ch\.bs\.demo_stna/);
      assert.ok(types.some(type => type.includes(mode === "auto" ? "application/json" : "text/event-stream")));
    } finally { await client.close(); }
  }

  const runtime = JSON.parse(docker("exec", name, "node", "--input-type=module", "-e", `
    import {readFileSync, writeFileSync, existsSync} from 'node:fs';
    const manifest=JSON.parse(readFileSync('/app/release.json','utf8'));
    let readOnly=false;
    try {writeFileSync('/app/smoke-must-not-write','x')} catch(e) {readOnly=['EROFS','EACCES'].includes(e.code)}
    console.log(JSON.stringify({uid:process.getuid(),node:process.versions.node,
      pin:readFileSync('/app/.node-version','utf8').trim(),readOnly,
      sourceCommit:manifest.commit,sourceClean:manifest.sourceClean,
      platform:process.platform,manifestPlatform:manifest.os,arch:process.arch,manifestArch:manifest.arch,
      buildTools:existsSync('/app/node_modules')||existsSync('/app/.git'),key:!!process.env.GEOBS_API_KEY,
      packageManagers:['/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/corepack','/usr/local/lib/node_modules'].some(existsSync)}));
  `));
  assert.notEqual(runtime.uid, 0);
  assert.equal(runtime.node, runtime.pin);
  assert.equal(runtime.readOnly, true);
  assert.equal(runtime.sourceCommit, null);
  assert.equal(runtime.sourceClean, null);
  assert.equal(runtime.manifestPlatform, runtime.platform);
  assert.equal(runtime.manifestArch, runtime.arch);
  assert.equal(runtime.buildTools, false);
  assert.equal(runtime.packageManagers, false);
  assert.equal(runtime.key, false);

  docker("restart", "--time", "10", name);
  // Docker may assign a new ephemeral host port when restarting the container.
  base = publishedBase();
  await waitForLive();
  assert.equal((await localFetch(`${base}/health/ready`)).status, 200);

  // Remove the test container's only network, then prove that MCP and the local
  // catalog still work. No Cloudflare runtime/service or remote cache is needed.
  docker("network", "disconnect", "bridge", name);
  const offline = JSON.parse(docker("exec", name, "node", "--input-type=module", "-e", `
    const live=await fetch('http://127.0.0.1:8080/health/live');
    const ready=await fetch('http://127.0.0.1:8080/health/ready');
    const res=await fetch('http://127.0.0.1:8080/mcp',{method:'POST',
      headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
    const frames=(await res.text()).split('\\n').filter(s=>s.startsWith('data:')).map(s=>JSON.parse(s.slice(5)));
    console.log(JSON.stringify({live:live.status,ready:ready.status,tools:frames.find(f=>f.result?.tools).result.tools.map(t=>t.name).sort()}));
  `));
  assert.deepEqual(offline, { live: 200, ready: 200, tools: toolNames });
  const docs = JSON.parse(docker("exec", name, "node", "--input-type=module", "-e", `
    const spec=await (await fetch('http://127.0.0.1:8080/openapi.json')).json();
    const assets=[];
    for(const file of ['swagger-ui-bundle.js','swagger-ui.css','swagger-initializer.js']) {
      const response=await fetch('http://127.0.0.1:8080/docs/'+file);
      assets.push(response.status===200 && (await response.text()).length>100);
    }
    console.log(JSON.stringify({openapi:spec.openapi,assets}));
  `));
  assert.deepEqual(docs, { openapi: "3.1.0", assets: [true, true, true] });
  // Exactly the init-container CLI: an existing valid snapshot needs neither
  // network nor write permission, and must not refresh on every Pod restart.
  docker("exec", name, "node", "/app/refresh.mjs", "--ensure");
  docker("stop", "--time", "10", name);
  assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", name), "0");
  console.log(JSON.stringify({ result: "passed", image, node: runtime.node,
    checks: ["published port / pod listener", "non-root", "read-only filesystem",
      "no package managers", "missing catalog readiness", "valid catalog readiness", "five tools", "modern JSON", "legacy SSE",
      "synthetic catalog search", "Host/Origin rejection", "persistent catalog after restart",
      "MCP without network", "local Swagger/OpenAPI without network", "catalog ensure without network or writes", "SIGTERM exit 0"] }));
} catch (error) {
  if (created) process.stderr.write(docker("logs", name).slice(-4_000));
  throw error;
} finally {
  if (created) docker("rm", "--force", name);
  if (!temporary.startsWith(prefix)) throw new Error("Unexpected cleanup path");
  await rm(temporary, { recursive: true, force: true });
}
