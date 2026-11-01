import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, mkdtemp } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const runtime = (await readFile(".node-version", "utf8")).trim();
if (process.versions.node !== runtime) throw new Error(`Build with Node.js ${runtime}.`);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const release = process.argv.includes("--release");
if (release && git("status", "--porcelain", "--untracked-files=all")) throw new Error("Commit the intended sources before creating a pinned release.");
const commit = git("rev-parse", "HEAD");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const sha = body => createHash("sha256").update(body).digest("hex");
const id = `geobs-mcp-${pkg.version}-${commit.slice(0, 12)}-linux-x64`;
await mkdir("dist", { recursive: true });
const target = release ? await mkdtemp(resolve("dist", `${id}-stage-`)) : resolve("dist/node");
await mkdir(target, { recursive: true });
const outputs = await build({
  entryPoints: { server: "src/node/server.ts", refresh: "src/node/refresh.ts" },
  outdir: target, outExtension: { ".js": ".mjs" }, bundle: true,
  platform: "node", target: "node24", format: "esm", metafile: true,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: "eof"
});

// Include licenses for every dependency represented in the bundle, including
// nested packages. No installation directory or secret file enters the release.
const notices = new Map();
for (const input of Object.keys(outputs.metafile.inputs).filter(path => path.includes("node_modules/"))) {
  let dir = dirname(resolve(input));
  while (dir.startsWith(root) && dir !== root) {
    try {
      const info = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (info.name && info.version) {
        let license = "";
        for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENSE-MIT", "COPYING"]) {
          try { license = await readFile(join(dir, name), "utf8"); break; } catch {}
        }
        if (!license) throw new Error(`Missing license text for ${info.name}@${info.version}`);
        notices.set(`${info.name}@${info.version}`, `${info.name}@${info.version} (${info.license ?? "see license"})\n${license}`);
        break;
      }
    } catch (error) { if (!String(error).includes("ENOENT")) throw error; }
    dir = dirname(dir);
  }
}
await writeFile(join(target, "THIRD-PARTY-NOTICES.txt"), [...notices].sort().map(([, value]) => value).join("\n\n----------------\n\n"));
for (const [source, name] of [["LICENSE", "LICENSE"], ["package-lock.json", "package-lock.json"], ["docs/node-runtime.md", "INSTALL.md"], [".node-version", ".node-version"]]) {
  await copyFile(source, join(target, name));
}
const names = ["server.mjs", "refresh.mjs", "THIRD-PARTY-NOTICES.txt", "LICENSE", "package-lock.json", "INSTALL.md", ".node-version"];
if (release) {
  execFileSync("git", ["archive", "--format=tar.gz", `--output=${join(target, "source.tar.gz")}`, commit]);
  names.push("source.tar.gz");
}
const files = {};
for (const name of names) files[name] = sha(await readFile(join(target, name)));
const manifest = {
  name: pkg.name, version: pkg.version, commit, sourceClean: !git("status", "--porcelain", "--untracked-files=all"),
  runtime: `node-${runtime}`, os: "Ubuntu 24.04", arch: "amd64", bundledDependencies: true,
  entrypoints: { server: "server.mjs", refresh: "refresh.mjs" },
  dependencyLockSha256: files["package-lock.json"], files
};
await writeFile(join(target, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
names.push("release.json");
const sums = [];
for (const name of names) sums.push(`${sha(await readFile(join(target, name)))}  ${name}`);
await writeFile(join(target, "SHA256SUMS"), `${sums.join("\n")}\n`);
if (release) {
  await mkdir("dist/releases", { recursive: true });
  const archive = resolve("dist/releases", `${id}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", target, ...names, "SHA256SUMS"]);
  const digest = sha(await readFile(archive));
  await writeFile(`${archive}.sha256`, `${digest}  ${id}.tar.gz\n`);
  console.log(JSON.stringify({ archive, sha256: digest, commit, runtime, files }));
} else console.log(JSON.stringify({ directory: target, runtime, pinnedRelease: false }));
