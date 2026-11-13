# Standalone Node.js container

The production image runs the existing `src/node/` adapter and the same seven
read-only MCP tools. It needs Node.js, the local OGC catalog and HTTPS access to
`api.geo.bs.ch`; no Cloudflare runtime, account, KV, Worker or tunnel is required.
The existing stateless MCP handler library is bundled with the application.
No new MCP implementation, authentication scheme or tool interface is introduced.
The Cloudflare entry point remains in the repository during migration.

## Build and basic function test

From the repository root, with a Linux-container Docker engine:

```sh
docker build --build-arg NODE_VERSION="$(cat .node-version)" -t geobs-mcp:container-test .
npm ci
npm run test:container -- geobs-mcp:container-test
```

The default Dockerfile argument already matches `.node-version`. Overriding it
with a different version fails the build. Keep the pin, Dockerfile default and
`src/node/config.ts` runtime check together when updating Node. The runtime base
is the official exact-version `node:<version>-bookworm-slim` image; rebuilding
may pick up a newer base OS revision. Promote an immutable application image
digest through the operator's registry and deployment process.

The multi-stage build installs the locked dependencies without lifecycle scripts,
runs typechecking, the offline unit tests, the existing Node build and compiled
JSON/SSE smoke test. Only the bundles, licenses and build metadata are copied
into the final image. No project `node_modules`, build toolchain, Git checkout,
credentials or catalog data are included. The allowlisted `.dockerignore`
also excludes local/private files from the build context.

The opt-in `test:container` command starts a uniquely named temporary container
with synthetic metadata and no API key. It checks a host-published port, the
non-root runtime, read-only root filesystem, liveness, readiness with/without a
catalog, all seven tool names, modern JSON and legacy SSE, a real cached search,
Host/Origin rejection, restart persistence and graceful SIGTERM. It then
disconnects the container's network and verifies local health and MCP again.
It also reuses the valid catalog through the compiled `refresh.mjs --ensure`
CLI with no network and a read-only catalog mount.
It removes its own container and temporary fixtures. No GeoBS requests are made.
This is a container acceptance check, not an EKS or connected-chat acceptance.

Ordinary `npm run build:node` also works without Git, as required inside a
Docker build context. In that case `release.json` records `commit: null` and
`sourceClean: null`; it does not claim a verified source revision. CI should
associate the image digest with its actual source revision. The existing
`npm run release:node` still requires a clean Git checkout and includes its
pinned source archive. `npm run check` and `npm run test:node-build` remain usable.

## Run and initialise the catalog

The image runs as UID/GID **1000:1000**, starts Node directly as PID 1 and
listens on **0.0.0.0:8080**. The non-container default stays on loopback.
Create and populate a persistent catalog volume before expecting readiness:

```sh
docker volume create geobs-mcp-catalog
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount type=volume,source=geobs-mcp-catalog,target=/var/lib/geobs-mcp/catalog \
  geobs-mcp:container-test /app/refresh.mjs

docker run --rm --name geobs-mcp-local --read-only --cap-drop ALL \
  --security-opt no-new-privileges -p 127.0.0.1:8080:8080 \
  --mount type=volume,source=geobs-mcp-catalog,target=/var/lib/geobs-mcp/catalog,readonly \
  geobs-mcp:container-test
```

The initial refresh command intentionally accesses the public GeoBS metadata
service. Normal server startup and healthchecks do not refresh or probe it.
The same refresh command can run later with the catalog volume writable.
The application can keep that volume read-only. Mount the **directory**, not
the individual snapshot file: refresh atomically replaces the file.

```sh
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
```

`/mcp` is Streamable HTTP, not a browser page. Use the automated smoke test or
an MCP client to exercise it. `/health/live` is process liveness; readiness
returns 503 for a missing, invalid or expired catalog. Neither validates the
upstream API key. The missing-key tools return the existing controlled error;
all seven tools are still registered. No endpoint or schema is renamed.

## Configuration and credentials

The [Node runtime guide](node-runtime.md) describes the full configuration.
Container-specific details:

| Setting | Behaviour |
| --- | --- |
| `GEOBS_BIND_ADDRESS` | Numeric IPv4/IPv6 bind address. Image default `0.0.0.0`; native default `127.0.0.1`. Port remains 8080. This does not change allowed Hosts/Origins. |
| `GEOBS_ALLOWED_HOSTS` | Exact HTTP authorities including significant ports. Add the public hostname and keep `localhost:8080` for the probe examples below. No wildcard. |
| `GEOBS_ALLOWED_ORIGINS` | Exact allowed browser origins, HTTPS outside loopback. Clients without Origin remain supported. |
| `GEOBS_MAX_CONCURRENT_REQUESTS` | Maximum parallel `/mcp` exchanges per process (1–9999, default 32). Excess requests receive HTTP 503 with `Retry-After: 1` before their body is read. |
| `GEOBS_CATALOG_PATH` | Default `/var/lib/geobs-mcp/catalog/ogc-catalog.v1.json`. Mount its parent directory. |
| `GEOBS_PUBLIC_BASE_PATH` | Optional versioned gateway prefix, e.g. `/geobs-mcp/v1`; serves Swagger/OpenAPI and a public MCP alias. Internal `/mcp` stays available. |
| `GEOBS_API_KEY_FILE` | Optional absolute path to a read-only mounted secret file. Needed for Search v2 and Grundstückinfo. |

For a public host, for example, set
`GEOBS_ALLOWED_HOSTS=geo.example.test,localhost:8080,127.0.0.1:8080` and
`GEOBS_ALLOWED_ORIGINS=https://geo.example.test`. Do not change the binding to
loopback when the service must be reached over a Pod IP. Forwarded headers do
not override the allowlists; ingress must preserve/configure the intended Host.
Ensure ingress streams MCP responses, with suitable timeouts and no SSE buffering.
Anonymous access is preserved; manage public traffic limits at the platform edge.

Mount a protected API-key file read-only and set, for example,
`GEOBS_API_KEY_FILE=/run/secrets/geobs-api-key`. Never pass its value as a build
argument, image layer, command-line argument or committed file. A Kubernetes
Secret can expose that file to UID 1000; use the platform's permissions and
secret-management policy. The server does not read a plaintext `GEOBS_API_KEY`
environment variable or a `.env` file. The refresh job needs no API key.

## Kubernetes integration points

The image includes local Swagger UI assets and generated OpenAPI. See the
[public API guide](public-api.md) for `/docs`, `/openapi.json`, versioned public
URLs, gateway routing and browser tests. No CDN or additional service is needed.

The [generic Helm chart](../charts/geobs-mcp/README.md) provides a Deployment,
Service, optional PVC, first-start init container and weekly refresh CronJob.
Its values support existing PVCs and API-key Secrets, probes and resource/security
settings. `npm run test:helm` renders and validates it without a cluster.
A platform-specific
GitLab pipeline, Argo application, ingress and production rollout are separate
operator configuration; none is installed by building this image.

Use the same image and UID for the application and catalog writer. The chart
populates a missing/expired catalog in an init container before the server
starts, reusing a valid snapshot with `refresh.mjs --ensure`. For manual manifests,
populate the catalog before waiting for application readiness; a Job waiting
for a ready application would create a dependency cycle.
Schedule `/app/refresh.mjs` on Wednesday at 03:00 with `timeZone: Europe/Zurich`
and `concurrencyPolicy: Forbid`, including the platform's missed-run policy.
The image itself runs no cron daemon. Configure alerts for a failed refresh.

Storage must support atomic rename and the existing file-sync/locking behaviour.
Do not assume a `ReadWriteOnce` volume can be used concurrently from pods on
different nodes. Choose compatible scheduling or shared storage with the
platform team before separating the app and refresh Job or adding replicas.
Ensure UID 1000 can write the mounted directory during refresh; replacement
files have mode 0600, so a different reader UID cannot rely on `fsGroup` alone.

Suggested container/pod settings (adapt to the platform):

```yaml
# pod.spec.securityContext
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
```

```yaml
# container.securityContext
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
```

HTTP probes reach the Pod IP, but must send an allowed Host. With
`localhost:8080` retained in `GEOBS_ALLOWED_HOSTS`, use:

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 8080
    httpHeaders:
      - name: Host
        value: localhost:8080
  periodSeconds: 30
  timeoutSeconds: 5
readinessProbe:
  httpGet:
    path: /health/ready
    port: 8080
    httpHeaders:
      - name: Host
        value: localhost:8080
  periodSeconds: 10
  timeoutSeconds: 5
```

Set CPU/memory requests and limits from platform measurements. Permit outbound
HTTPS/DNS as needed for `api.geo.bs.ch`. Logs are JSON on stdout; shutdown uses
SIGTERM. Keep a termination grace period sufficient to stop active exchanges.
No TLS certificate or cloud-provider credential belongs in the application image.

References: [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/),
[Docker build context](https://docs.docker.com/build/concepts/context/#dockerignore-files),
[official Node images](https://github.com/nodejs/docker-node),
[Kubernetes probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/),
[CronJob time zones](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/#time-zones).
