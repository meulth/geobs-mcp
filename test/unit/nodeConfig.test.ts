import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeConfig, NODE_VERSION, readApiKey } from "../../src/node/config";

describe("Node listener configuration", () => {
  it("preserves loopback by default and matches the repository runtime pin", () => {
    expect(nodeConfig({}).bindAddress).toBe("127.0.0.1");
    expect(NODE_VERSION).toBe(readFileSync(new URL("../../.node-version", import.meta.url), "utf8").trim());
  });

  it.each(["0.0.0.0", "127.0.0.1", "::", "::1", "10.20.30.40"])("accepts an explicit numeric listener %s", address => {
    expect(nodeConfig({ GEOBS_BIND_ADDRESS: address }).bindAddress).toBe(address);
  });

  it.each(["", " ", "*", "localhost", "http://0.0.0.0", "0.0.0.0:8080", "999.1.2.3", "fe80::1%eth0"])("rejects an invalid listener %j", address => {
    expect(() => nodeConfig({ GEOBS_BIND_ADDRESS: address })).toThrow("GEOBS_BIND_ADDRESS");
  });
});

describe("Node credential boundary with synthetic files only", () => {
  it("loads the systemd credential file and allows an explicit file override", async () => {
    const prefix = join(tmpdir(), "geobs-credential-test-");
    const directory = await mkdtemp(prefix);
    try {
      await writeFile(join(directory, "GEOBS_API_KEY"), "synthetic-systemd-key\n");
      await writeFile(join(directory, "override"), "synthetic-override-key");
      expect(await readApiKey({ CREDENTIALS_DIRECTORY: directory })).toBe("synthetic-systemd-key");
      expect(await readApiKey({ CREDENTIALS_DIRECTORY: directory, GEOBS_API_KEY_FILE: join(directory, "override") })).toBe("synthetic-override-key");
    } finally {
      if (!directory.startsWith(prefix)) throw new Error("Unexpected cleanup path");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores a plain environment key and rejects relative credential paths", async () => {
    expect(await readApiKey({ GEOBS_API_KEY: "must-not-be-consumed" })).toBeUndefined();
    await expect(readApiKey({ GEOBS_API_KEY_FILE: "relative-key" })).rejects.toThrow("absolute");
  });
});
