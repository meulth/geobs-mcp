import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readApiKey } from "../../src/node/config";

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
