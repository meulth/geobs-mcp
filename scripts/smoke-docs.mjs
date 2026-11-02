import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

// Real browser against the compiled artifact, loopback proxies and a synthetic
// local catalog. Executes only cached search/list; no key or GeoBS call needed.
const artifact = resolve(process.argv[2] ?? "dist/node");
const prefix = join(tmpdir(), "geobs-docs-test-");
const temporary = await mkdtemp(prefix);
const catalog = join(temporary, "catalog.json");
const collections = [{ id: "ch.bs.strassennamen_stna", title: "Strassennamen" }];
await writeFile(catalog, JSON.stringify({
  schemaVersion: 1, source: "https://api.geo.bs.ch/ogc/v1/wfs3/collections?f=json",
  fetchedAt: new Date().toISOString(), collectionCount: 1, collections,
  contentHash: createHash("sha256").update(JSON.stringify(collections)).digest("hex")
}));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const mode of ["direct", "preserve", "strip"]) {
    const publicPath = mode === "direct" ? "" : "/geobs-mcp/v1";
    const proxy = createServer((incoming, outgoing) => {
      const path = mode === "strip"
        ? incoming.url.replace(/^\/geobs-mcp\/v1(?=\/|\?|$)/, "") || "/"
        : incoming.url;
      const upstream = httpRequest({ hostname: "127.0.0.1", port: 8080, path, method: incoming.method, headers: incoming.headers }, response => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      });
      upstream.once("error", () => { outgoing.writeHead(502); outgoing.end(); });
      incoming.pipe(upstream);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const authority = `127.0.0.1:${proxy.address().port}`;
    const base = `http://${authority}`;
    const child = spawn(process.execPath, [join(artifact, "server.mjs")], {
      cwd: temporary, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        SystemRoot: process.env.SystemRoot, GEOBS_CATALOG_PATH: catalog,
        GEOBS_ALLOWED_HOSTS: `${authority},127.0.0.1:8080`,
        GEOBS_ALLOWED_ORIGINS: base, GEOBS_PUBLIC_BASE_PATH: publicPath
      }
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    const deadline = setTimeout(() => child.kill(), 60_000);
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    const external = [];
    const browserErrors = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin !== base) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    try {
      await new Promise((ready, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`Compiled server stopped: ${errors.slice(0, 300)}`)));
        child.stdout.on("data", () => { if (output.includes('"server_started"')) ready(); });
      });
      await page.goto(`${base}${publicPath || "/docs"}`);
      await page.locator(".opblock-summary").click();
      await page.getByRole("button", { name: "Try it out" }).click();
      const selector = page.locator("select").filter({ has: page.locator('option[value="search_datasets_ogc"]') });
      for (const name of ["search_api_v2", "get_dataset_stac", "query_features_ogc", "get_property_info", "search_datasets_ogc"]) {
        assert.equal(await selector.locator(`option[value="${name}"]`).count(), 1);
      }
      await selector.selectOption("search_datasets_ogc");
      const requestPromise = page.waitForRequest(request => request.method() === "POST");
      const responsePromise = page.waitForResponse(response => response.request().method() === "POST");
      await page.getByRole("button", { name: "Execute", exact: true }).click();
      const request = await requestPromise;
      const response = await responsePromise;
      assert.equal(new URL(request.url()).pathname, `${publicPath}/mcp`);
      const headers = request.headers();
      assert.equal(headers.accept, "application/json, text/event-stream");
      assert.equal(headers["content-type"], "application/json");
      assert.equal(headers["mcp-protocol-version"], "2025-11-25");
      assert.equal(request.postDataJSON().params.name, "search_datasets_ogc");
      const curl = await page.locator(".curl-command").innerText();
      assert.match(curl, /application\/json, text\/event-stream/);
      assert.match(curl, /tools\/call/);
      assert.equal(response.status(), 200);
      assert.match(response.headers()["content-type"], /text\/event-stream/);
      const body = await response.text();
      assert.match(body, /data:/);
      assert.match(body, /ch\.bs\.strassennamen_stna/);
      await page.locator(".responses-wrapper").getByText(/ch\.bs\.strassennamen_stna/).first().waitFor();
      assert.equal(await page.locator(".errors-wrapper:visible").count(), 0,
        await page.locator(".errors-wrapper:visible").allTextContents());
      assert.deepEqual(browserErrors, []);
      assert.deepEqual(external, [], "Swagger must not request a CDN, validator or external spec");
      if (process.env.DOCS_SCREENSHOT_DIR) {
        const directory = resolve(process.env.DOCS_SCREENSHOT_DIR);
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: join(directory, `docs-${mode}.png`), fullPage: true });
      }
      console.log(JSON.stringify({ result: "passed", mode, checks: ["local Swagger assets", "five documented tools", "Try it out", "JSON-RPC headers", "raw SSE result", "public prefix", "no external browser requests"] }));
    } finally {
      clearTimeout(deadline);
      await page.close();
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
      child.kill("SIGTERM");
      await exited;
      proxy.closeAllConnections();
      await new Promise((done, reject) => proxy.close(error => error ? reject(error) : done()));
    }
  }
} finally {
  await browser?.close();
  if (!temporary.startsWith(prefix)) throw new Error("Unexpected cleanup path");
  await rm(temporary, { recursive: true, force: true });
}
