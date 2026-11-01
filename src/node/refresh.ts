import { FileCatalog } from "./fileCatalog";
import { checkRuntime, jsonLog, nodeConfig } from "./config";
import { withTelemetry } from "../telemetry";

// Administrative CLI only: the systemd calendar supplies Wednesday 03:00
// Europe/Zurich and Persistent=true. Direct execution also supports initial
// population and a missed-calendar catch-up outside that exact minute.
async function main() {
  checkRuntime();
  const { catalogPath } = nodeConfig(process.env);
  await withTelemetry(() => new FileCatalog(catalogPath).refresh(), jsonLog);
}
main().catch(() => { jsonLog({ service: "geobs-mcp", event: "refresh_failed" }); process.exitCode = 1; });
