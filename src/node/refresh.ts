import { FileCatalog } from "./fileCatalog";
import { checkRuntime, jsonLog, nodeConfig } from "./config";
import { withTelemetry } from "../telemetry";

// Administrative CLI only. An external timer/CronJob supplies the schedule.
// --ensure is for init containers: reuse valid snapshots, populate missing or
// expired ones. Without it, always perform the normal bounded weekly refresh.
async function main() {
  checkRuntime();
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--ensure")) throw new Error("Usage: refresh.mjs [--ensure]");
  const { catalogPath } = nodeConfig(process.env);
  const catalog = new FileCatalog(catalogPath);
  await withTelemetry(() => args[0] === "--ensure" ? catalog.ensure() : catalog.refresh(), jsonLog);
}
main().catch(() => { jsonLog({ service: "geobs-mcp", event: "refresh_failed" }); process.exitCode = 1; });
