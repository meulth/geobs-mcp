import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";

export const NODE_VERSION = "24.20.0";
export const APP_PORT = 8080;
export const DEFAULT_CATALOG_PATH = "/var/lib/geobs-mcp/catalog/ogc-catalog.v1.json";
export const jsonLog = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

type ConfigEnvironment = Record<string, string | undefined>;
export function nodeConfig(env: ConfigEnvironment) {
  const bindAddress = env.GEOBS_BIND_ADDRESS ?? "127.0.0.1";
  if (!isIP(bindAddress) || bindAddress.includes("%")) throw new Error("GEOBS_BIND_ADDRESS must be an IPv4 or IPv6 address.");
  const hosts = (env.GEOBS_ALLOWED_HOSTS ?? "127.0.0.1:8080,localhost:8080").split(",").map(s => s.trim().toLowerCase());
  const origins = (env.GEOBS_ALLOWED_ORIGINS ?? "http://127.0.0.1:8080,http://localhost:8080").split(",").map(s => s.trim());
  for (const host of hosts) {
    const url = new URL(`http://${host}`);
    if (!host || url.host !== host || url.username || url.password || /[/?#*]/.test(host)) throw new Error("Invalid allowed Host configuration.");
  }
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Invalid allowed Origin configuration.");
  }
  const catalogPath = env.GEOBS_CATALOG_PATH ?? DEFAULT_CATALOG_PATH;
  if (!isAbsolute(catalogPath)) throw new Error("GEOBS_CATALOG_PATH must be absolute.");
  return { hosts, origins, catalogPath, bindAddress };
}

export async function readApiKey(env: ConfigEnvironment): Promise<string | undefined> {
  const path = env.GEOBS_API_KEY_FILE ?? (env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, "GEOBS_API_KEY") : undefined);
  if (!path) return undefined;
  if (!isAbsolute(path)) throw new Error("The credential path must be absolute.");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65_536) throw new Error("Invalid credential file.");
    const value = (await file.readFile("utf8")).trim();
    if (!value || /[\r\n]/.test(value)) throw new Error("Invalid credential file.");
    return value;
  } finally { await file.close(); }
}

export function checkRuntime() {
  if (process.versions.node !== NODE_VERSION) throw new Error(`This release requires Node.js ${NODE_VERSION}.`);
  if (process.getuid?.() === 0) throw new Error("Run GeoBS-MCP as an unprivileged user.");
}
