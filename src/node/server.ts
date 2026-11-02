import { FileCatalog } from "./fileCatalog";
import { APP_PORT, checkRuntime, jsonLog, nodeConfig, readApiKey } from "./config";
import { createNodeServer } from "./http";

async function main() {
  checkRuntime();
  const config = nodeConfig(process.env);
  const app = createNodeServer({ ...config, apiKey: await readApiKey(process.env), catalog: new FileCatalog(config.catalogPath), log: jsonLog });
  app.server.listen(APP_PORT, config.bindAddress, () => jsonLog({ service: "geobs-mcp", event: "server_started", port: APP_PORT }));
  app.server.once("error", () => { jsonLog({ service: "geobs-mcp", event: "server_error" }); process.exitCode = 1; });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void app.close().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
main().catch(() => { jsonLog({ service: "geobs-mcp", event: "startup_error" }); process.exitCode = 1; });
