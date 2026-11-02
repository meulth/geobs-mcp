import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";

// Helm rendering + Kubernetes JSON schemas only. No kubectl, cluster or AWS.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = join(root, "charts/geobs-mcp");
const helm = process.env.HELM ?? "helm";
const kubeconform = process.env.KUBECONFORM ?? "kubeconform";
const prefix = join(tmpdir(), "geobs-helm-test-");
const temporary = await mkdtemp(prefix);
const run = (binary, args, input) => execFileSync(binary, args, {
  cwd: root, encoding: "utf8", input, timeout: 120_000, windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"]
});
let validCases = 0;
let rejectedCases = 0;
async function render(name, values = {}, kubeVersion = "1.27.0") {
  const path = join(temporary, `${name}.json`);
  await writeFile(path, JSON.stringify(values));
  const yaml = run(helm, ["template", "smoke", chart, "--namespace", "geo-test", "--kube-version", kubeVersion, "--values", path]);
  const docs = parseAllDocuments(yaml).map(document => {
    assert.deepEqual(document.errors, [], "invalid/duplicate YAML keys");
    return document.toJSON();
  }).filter(Boolean);
  const validation = JSON.parse(run(kubeconform, ["-strict", "-summary", "-output", "json", "-kubernetes-version", kubeVersion,
    "-cache", temporary, ...(process.env.KUBECONFORM_SCHEMA_LOCATION ? ["-schema-location", process.env.KUBECONFORM_SCHEMA_LOCATION] : [])], yaml));
  assert.equal(validation.summary.invalid, 0);
  assert.equal(validation.summary.errors, 0);
  assert.equal(validation.summary.skipped, 0);
  assert.equal(validation.summary.valid, docs.length);
  assert.ok(docs.every(resource => resource.metadata.namespace === "geo-test"));
  validCases++;
  return { docs, get: kind => docs.find(resource => resource.kind === kind) };
}
async function rejects(name, values, expected, kubeVersion = "1.27.0") {
  const path = join(temporary, `${name}.json`);
  await writeFile(path, JSON.stringify(values));
  assert.throws(() => run(helm, ["template", "smoke", chart, "--kube-version", kubeVersion, "--values", path]),
    error => expected.test(String(error.stderr)), name);
  rejectedCases++;
}
const catalogMount = container => container.volumeMounts.find(volume => volume.name === "catalog");
const pod = deployment => deployment.spec.template.spec;
const jobPod = cron => cron.spec.jobTemplate.spec.template.spec;
function sharedContract(result, expectedClaim) {
  const app = pod(result.get("Deployment"));
  const cron = result.get("CronJob");
  const containers = [...app.containers, ...(app.initContainers ?? [])];
  const jobs = cron ? [jobPod(cron)] : [];
  const config = result.get("ConfigMap");
  for (const spec of [app, ...jobs]) {
    assert.equal(spec.automountServiceAccountToken, false);
    assert.equal(spec.securityContext.runAsNonRoot, true);
    assert.equal(spec.volumes.find(volume => volume.name === "catalog").persistentVolumeClaim.claimName, expectedClaim);
    for (const container of [...spec.containers, ...(spec.initContainers ?? [])]) {
      assert.equal(container.envFrom[0].configMapRef.name, config.metadata.name);
      assert.equal(catalogMount(container).mountPath, config.data.GEOBS_CATALOG_PATH.slice(0, config.data.GEOBS_CATALOG_PATH.lastIndexOf("/")));
      assert.equal(catalogMount(container).subPath, undefined, "atomic replacement needs a directory mount");
    }
  }
  if (cron) {
    containers.push(...jobPod(cron).containers);
    assert.equal(cron.spec.concurrencyPolicy, "Forbid");
    assert.equal(jobPod(cron).volumes.length, 1, "refresh must not receive the API-key Secret");
    assert.deepEqual(jobPod(cron).containers[0].args, ["/app/refresh.mjs"]);
    assert.notEqual(catalogMount(jobPod(cron).containers[0]).readOnly, true);
  }
  if (app.initContainers) {
    assert.deepEqual(app.initContainers[0].args, ["/app/refresh.mjs", "--ensure"]);
    assert.equal(app.initContainers[0].volumeMounts.length, 1, "init must not receive the API-key Secret");
    assert.notEqual(catalogMount(app.initContainers[0]).readOnly, true);
  }
  const server = app.containers[0];
  assert.equal(catalogMount(server).readOnly, true);
  for (const container of containers) {
    assert.equal(container.image, server.image);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
    assert.ok(container.resources.requests && container.resources.limits);
  }
  for (const [probe, path] of [[server.livenessProbe, "/health/live"], [server.readinessProbe, "/health/ready"]]) {
    assert.equal(probe.httpGet.path, path);
    assert.equal(probe.httpGet.port, "http");
    assert.ok(config.data.GEOBS_ALLOWED_HOSTS.split(",").includes(probe.httpGet.httpHeaders[0].value));
  }
  const service = result.get("Service");
  for (const [key, value] of Object.entries(service.spec.selector)) assert.equal(result.get("Deployment").spec.template.metadata.labels[key], value);
  assert.notEqual(cron?.spec.jobTemplate.spec.template.metadata.labels["app.kubernetes.io/component"], "server");
  assert.ok(result.docs.every(resource => !resource.metadata.annotations?.["helm.sh/hook"]));
}

try {
  run(helm, ["lint", chart, "--strict"]);
  const defaults = await render("defaults");
  assert.deepEqual(defaults.docs.map(resource => resource.kind).sort(), ["ConfigMap", "CronJob", "Deployment", "PersistentVolumeClaim", "Service"].sort());
  sharedContract(defaults, defaults.get("PersistentVolumeClaim").metadata.name);
  assert.deepEqual(defaults.get("PersistentVolumeClaim").spec.accessModes, ["ReadWriteMany"]);
  assert.equal(defaults.get("PersistentVolumeClaim").metadata.annotations["helm.sh/resource-policy"], "keep");
  assert.equal(defaults.get("PersistentVolumeClaim").spec.storageClassName, undefined);
  assert.equal(defaults.get("CronJob").spec.schedule, "0 3 * * 3");
  assert.equal(defaults.get("CronJob").spec.timeZone, "Europe/Zurich");
  assert.equal(pod(defaults.get("Deployment")).volumes.length, 1);

  const exampleValues = parseAllDocuments(await readFile(join(chart, "values.example.yaml"), "utf8"))[0];
  assert.deepEqual(exampleValues.errors, []);
  const example = await render("documented-example", exampleValues.toJSON());
  sharedContract(example, "geobs-catalog");
  assert.equal(example.get("ConfigMap").data.GEOBS_PUBLIC_BASE_PATH, "/geobs-mcp/v1");
  assert.equal(example.get("PersistentVolumeClaim"), undefined);
  assert.equal(pod(example.get("Deployment")).volumes.find(volume => volume.name === "api-key").secret.secretName, "geobs-api-key");

  const external = await render("existing-pvc-secret-digest", {
    image: { repository: "registry.example.test/team/geobs-mcp", digest: `sha256:${"a".repeat(64)}` },
    replicaCount: 2, persistence: { existingClaim: "shared-catalog" },
    apiKey: { existingSecret: "geobs-api-key", key: "custom-key" },
    config: { allowedHosts: ["geo.example.test", "localhost:8080"], allowedOrigins: ["https://geo.example.test"] },
    catalog: { mountPath: "/data/catalog", fileName: "metadata.json" },
    imagePullSecrets: [{ name: "registry-credentials" }]
  });
  sharedContract(external, "shared-catalog");
  assert.equal(external.get("PersistentVolumeClaim"), undefined);
  assert.equal(external.get("Secret"), undefined);
  const app = pod(external.get("Deployment"));
  assert.equal(app.containers[0].image, `registry.example.test/team/geobs-mcp@sha256:${"a".repeat(64)}`);
  assert.deepEqual(app.imagePullSecrets, jobPod(external.get("CronJob")).imagePullSecrets);
  assert.deepEqual(app.containers[0].env, [{ name: "GEOBS_API_KEY_FILE", value: "/run/secrets/geobs/api-key" }]);
  assert.deepEqual(app.volumes.find(volume => volume.name === "api-key").secret, {
    secretName: "geobs-api-key", defaultMode: 288, items: [{ key: "custom-key", path: "api-key" }]
  });

  const rwo = await render("single-node-rwo", {
    persistence: { existingClaim: "single-node-catalog", accessModes: ["ReadWriteOnce"], allowSingleNodeAccess: true },
    nodeSelector: { "kubernetes.io/hostname": "example-node" },
    tolerations: [{ key: "example-dedicated", operator: "Exists", effect: "NoSchedule" }]
  });
  sharedContract(rwo, "single-node-catalog");
  assert.equal(rwo.get("Deployment").spec.strategy.type, "Recreate");
  assert.deepEqual(pod(rwo.get("Deployment")).nodeSelector, jobPod(rwo.get("CronJob")).nodeSelector);
  assert.deepEqual(pod(rwo.get("Deployment")).tolerations, jobPod(rwo.get("CronJob")).tolerations);

  const manual = await render("prepopulated-no-jobs", {
    catalog: { initialize: false }, refresh: { enabled: false }, persistence: { existingClaim: "prepopulated-catalog" }
  });
  sharedContract(manual, "prepopulated-catalog");
  assert.equal(manual.docs.length, 3);
  assert.equal(pod(manual.get("Deployment")).initContainers, undefined);

  const tuned = await render("settings-and-long-names", {
    fullnameOverride: "example-" + "a".repeat(54), service: { port: 8088 },
    persistence: { storageClassName: "", retain: false, annotations: { "example.test/purpose": "catalog" } },
    resources: { requests: { cpu: "250m", memory: "192Mi" }, limits: { cpu: "1", memory: "512Mi" } },
    podSecurityContext: { runAsUser: 2000, runAsGroup: 2000, fsGroup: 2000 },
    refresh: { suspend: true }, probes: { readiness: { periodSeconds: 17 } }
  });
  sharedContract(tuned, tuned.get("PersistentVolumeClaim").metadata.name);
  assert.equal(tuned.get("PersistentVolumeClaim").spec.storageClassName, "");
  assert.equal(tuned.get("PersistentVolumeClaim").metadata.annotations["helm.sh/resource-policy"], undefined);
  assert.ok(tuned.get("CronJob").metadata.name.length <= 52);
  assert.equal(pod(tuned.get("Deployment")).containers[0].resources.requests.cpu, "250m");
  assert.equal(pod(tuned.get("Deployment")).containers[0].readinessProbe.periodSeconds, 17);
  assert.deepEqual(pod(tuned.get("Deployment")).securityContext, jobPod(tuned.get("CronJob")).securityContext);
  assert.equal(tuned.get("CronJob").spec.suspend, true);

  await rejects("rwo-unacknowledged", { persistence: { accessModes: ["ReadWriteOnce"] } }, /requires ReadWriteMany/);
  await rejects("rwo-replicas", { replicaCount: 2, persistence: { accessModes: ["ReadWriteOnce"], allowSingleNodeAccess: true } }, /replicaCount=1/);
  await rejects("rwop", { persistence: { accessModes: ["ReadWriteOncePod"] } }, /accessModes/);
  await rejects("bad-probe-host", { config: { allowedHosts: ["geo.example.test"] } }, /probes.host/);
  await rejects("root-user", { podSecurityContext: { runAsUser: 0 } }, /runAsUser/);
  await rejects("literal-secret", { apiKey: { value: "synthetic-not-a-key" } }, /value/);
  await rejects("empty-image", { image: { repository: "" } }, /repository/);
  await rejects("catalog-path-traversal", { catalog: { mountPath: "/data/../app" } }, /mountPath/);
  await rejects("old-kubernetes", {}, /kubeVersion/, "1.26.0");
  await rejects("public-prefix-url", { config: { publicBasePath: "https://geo.example.test/geobs-mcp/v1" } }, /publicBasePath/);
  await rejects("public-prefix-reserved", { config: { publicBasePath: "/mcp/v1" } }, /publicBasePath/);
  console.log(JSON.stringify({ result: "passed", validCases, rejectedCases,
    kubernetesSchema: "1.27.0", clusterAccess: false }));
} finally {
  if (!temporary.startsWith(prefix)) throw new Error("Unexpected cleanup path");
  await rm(temporary, { recursive: true, force: true });
}
