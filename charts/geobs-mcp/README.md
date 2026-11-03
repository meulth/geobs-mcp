# geobs-mcp Helm chart

Generic Kubernetes deployment of the repository's standalone Node.js image.
Requires Helm 3 and Kubernetes **1.27 or newer** (CronJob `timeZone`). The chart
does not depend on AWS, Cloudflare, Argo CD, a particular ingress controller or
a database. It creates a Deployment, Service, ConfigMap, optional PVC and CronJob.
The existing five tools and Streamable HTTP `/mcp` interface are unchanged.

## Build and install

Build the [production Dockerfile](../../Dockerfile), test it and publish it to
your own registry. No pre-published `geobs-mcp` image is assumed. These commands
are examples for the operator; rendering/testing the chart installs nothing.

```sh
docker build -t registry.example.test/team/geobs-mcp:0.1.0 .
npm ci
npm run test:container -- registry.example.test/team/geobs-mcp:0.1.0
docker push registry.example.test/team/geobs-mcp:0.1.0
```

Copy [values.example.yaml](values.example.yaml) to your deployment repository and
replace its registry, hostname and existing claim/Secret references. Prefer
`image.digest: sha256:<actual-image-digest>` for promotion; a digest takes
precedence over `image.tag`. Multi-platform images must be built for the target
nodes; this chart does not select an architecture or provision storage.

For the key-dependent Search v2 and Grundstückinfo tools, create a Secret from a
protected local file using your platform's secret-management process, for example:

```sh
kubectl create namespace geo-services
kubectl --namespace geo-services create secret generic geobs-api-key \
  --from-file=GEOBS_API_KEY=/path/to/protected/api-key
helm upgrade --install geo ./charts/geobs-mcp --namespace geo-services \
  --values /path/to/deployment-values.yaml --wait --timeout 5m
```

The chart only references `apiKey.existingSecret`; it never creates a Secret or
accepts a literal key in values. The selected Secret entry is mounted read-only
at `/run/secrets/geobs/api-key`, mode 0440, and read through
`GEOBS_API_KEY_FILE`. Only the server mounts it; init/refresh need no key. Without
a key all five tools remain registered; key-dependent calls fail with the
existing controlled error. Secret rotation requires a server rollout because
the key is read at process startup. Do not store keys in Git, values, images,
command arguments or logs.

The default Service is ClusterIP, port 80 to Pod port 8080. Configure public
HTTPS, DNS, rate limits and streaming/timeouts at the platform ingress. Add the
actual request authority to `config.allowedHosts` and intended browser origins
to `config.allowedOrigins`; ingress must preserve the configured Host. Clients
without an Origin header remain supported. The chart creates no ingress, TLS
certificate, cloud load balancer by default or authentication service.

## Persistent catalog and first start

By default the chart requests a 1Gi **ReadWriteMany** filesystem PVC. Select a
compatible `persistence.storageClassName`; `null` omits it and uses the cluster
default, while `""` explicitly requests no storage class. Alternatively set
`persistence.existingClaim` to a claim **in the same namespace**. No PVC is then
created or managed; `accessModes` must still accurately describe that claim.
Rendering cannot verify the actual volume capabilities or provisioner.

The server, Deployment init container and CronJob mount the same catalog
directory. The server mount is read-only, writers have write access. Mount the
directory rather than the snapshot via `subPath`: atomic replacement must be
visible to readers. Storage must support exclusive file creation, same-directory
atomic rename, file/directory sync and coherent reads across Pods. Check these
semantics on the selected CSI/filesystem; a RWX label alone is not proof.

The default init container runs `node /app/refresh.mjs --ensure`. It validates
and reuses an admissible snapshot without a network request, or creates a
missing/refreshes an expired snapshot through the existing bounded refresh.
It runs before the server, so `helm --wait` needs no separate Job/hook ordering.
An initial fetch failure keeps the Pod in init retry rather than reporting
readiness. Initialization requires working storage, DNS and outbound HTTPS to
`api.geo.bs.ch`. With `catalog.initialize: false`, populate a valid snapshot
administratively before starting the server. Readiness stays 503 until one exists.

All readers/writers must use the **same non-root UID**, default 1000. Replacement
files are private mode 0600; `fsGroup` alone cannot grant a different UID access.
The mounted directory must be writable by that UID for init/refresh. The default
`fsGroup: 1000` helps compatible CSI drivers establish directory permissions;
existing volumes/root-squashed exports may need operator preparation. Changing
UID requires migrating existing file ownership too.

RWX permits the app and CronJob to run on different nodes. Multiple app replicas
also require RWX and coherent reads; this chart makes no availability guarantee.
For **ReadWriteOnce**, explicitly set `allowSingleNodeAccess: true`, keep one app
replica, and enforce the **same single node** for app and CronJob through the
shared `nodeSelector`/`affinity` settings. RWO is node-scoped, not a multi-node
sharing mechanism; the chart uses a Recreate Deployment in this mode. The flag
acknowledges the constraint but does not discover/pin the correct node for you.
`ReadWriteOncePod` is unsupported because the app and writer are separate Pods.

Created PVCs have `helm.sh/resource-policy: keep` by default. This is a Helm
retention hint; configure other GitOps controllers' pruning policies separately.
It is not a backup; check the storage reclaim policy, protect the last good snapshot
and plan recovery separately. A retained PVC may require explicit adoption on
reinstallation. Existing claims are never deleted, resized or reconfigured by
the chart. PVC storage class/access mode changes can require a new claim and
operator migration; do not treat a values edit as a storage migration.

## Weekly refresh and failure handling

The CronJob runs **Wednesday at 03:00 Europe/Zurich**, with schedule `0 3 * * 3`
and the Kubernetes `timeZone` field. Daylight saving follows that zone. Defaults:
`concurrencyPolicy: Forbid`, 24-hour missed-start window, five-minute execution
deadline, two retries, one successful and three failed Jobs retained. These are
configurable through `refresh.*`; configure monitoring for failed/missed refresh.
Cron scheduling is not an exactly-once guarantee. `Forbid` covers this CronJob;
the existing filesystem lock also excludes overlapping init/manual writers.

The writer validates the source, bounds response size/count, checks the previous
snapshot, writes a same-directory temporary file, syncs it, atomically renames
it and syncs the directory on Linux. Invalid replacements and upstream failures
preserve the last good file. Schema/hash/count protections are unchanged. Up to
seven days is fresh, over seven through fourteen days is usable but stale; over
fourteen days is rejected. Request handling never silently refreshes the file.

A corrupt snapshot fails closed, including init; inspect/recover it through the
[existing catalog recovery procedure](../../docs/node-runtime.md#catalog-and-refresh).
A crashed/killed writer may leave `<catalog-path>.refresh.lock` or a temporary
file. A lock older than 15 minutes is taken over automatically by the next
refresh; keep `refresh.activeDeadlineSeconds` well below that. Confirm no writer
is active before removing an unused temporary file. Never edit an active snapshot in place or falsify its date.
For an immediate normal refresh, an operator can create a Job from the CronJob
(release `geo`, default chart name):

```sh
kubectl --namespace geo-services create job geo-catalog-manual \
  --from=cronjob/geo-geobs-mcp-refresh
```

Use a fresh Job name per execution. The same validation and shared file lock
apply; manual Jobs can conflict with initialization or the scheduled refresh.

## Configuration

The complete defaults are in [values.yaml](values.yaml); a JSON schema rejects
unknown top-level options and selected unsafe/inconsistent settings.

| Values | Purpose / default |
| --- | --- |
| `image.*`, `imagePullSecrets` | Own registry/tag or immutable digest; pull credentials are existing Secret references. |
| `replicaCount` | 1; more replicas require suitable shared storage. |
| `service.*` | ClusterIP, port 80, optional annotations; Pod port stays 8080. |
| `config.*` | Bind `0.0.0.0`, exact Host/Origin allowlists, optional `publicBasePath` such as `/geobs-mcp/v1`. IPv6 wildcard `::` is optional. |
| `catalog.*` | Mounted directory, snapshot basename, initial population enabled. |
| `persistence.*` | Existing claim or created PVC, class/mode/size, retention and annotations. |
| `apiKey.*` | Optional existing Secret and entry name; no key value. |
| `refresh.*` | Schedule, timezone, suspension, deadlines/retries/history and writer resources. |
| `resources` | App requests 100m/128Mi; limits 500m/256Mi. Writer defaults 100m/64Mi to 500m/256Mi. Starting values, not a measured sizing recommendation. |
| `podSecurityContext` | Shared non-root UID/GID/fsGroup 1000, RuntimeDefault seccomp. |
| `containerSecurityContext` | No privilege escalation, read-only root filesystem, all capabilities dropped. |
| `probes.*` | `/health/live`, `/health/ready`, timings, explicit allowed Host `localhost:8080`. Kubelet still connects to the Pod IP. |
| `nodeSelector`, `tolerations`, `affinity` | Applied to both the Deployment and CronJob. |
| `serviceAccountName` | Optional existing account. Token automount always disabled; no RBAC is needed. |
| `podAnnotations`, `terminationGracePeriodSeconds` | Common annotations; graceful shutdown defaults to 30 seconds. |
| `nameOverride`, `fullnameOverride` | Generic resource naming. |

A ConfigMap checksum rolls the Deployment when application configuration changes.
There are no Helm hooks, cluster lookups, cloud credentials or Argo-specific
resources. In GitOps, render the same chart/values through your chosen controller.
Image publication, Secret management and actual cluster rollout remain platform
tasks. Network policies must permit DNS/HTTPS to the fixed GeoBS origin and
the platform's inbound MCP traffic; this chart does not assume network selectors.

## Validate without a cluster

```sh
npm ci
helm lint charts/geobs-mcp --strict
helm template geo charts/geobs-mcp --namespace geo-services \
  --kube-version 1.27.0 --values charts/geobs-mcp/values.example.yaml
npm run test:helm
```

`test:helm` requires `helm` and `kubeconform` on PATH (or executable paths in
`HELM`/`KUBECONFORM`). It lints, renders six configurations, checks workload/
storage/Secret/probe contracts, validates every resource against strict Kubernetes
1.27 JSON schemas and rejects eleven invalid configurations. No `kubectl`, cluster
credentials or Kubernetes API is used. Schema downloads use public HTTPS; set
`KUBECONFORM_SCHEMA_LOCATION` to an appropriate local schema location/template
for disconnected validation. Tested with Helm 3.19.0 and kubeconform 0.7.0.
Offline rendering cannot establish storage permissions/semantics, actual CSI
support, admission policies, registry pulls, DNS, secrets or ingress streaming.
Verify these during a later platform deployment before accepting the rollout.

The example sets `config.publicBasePath: /geobs-mcp/v1`. Swagger UI, generated
OpenAPI and the public MCP alias then work under that prefix, with internal
`/mcp` preserved. See the [gateway/client guide](../../docs/public-api.md) for
both preserved/stripped routing, local asset paths, Host/Origin and SSE headers.

References: [Helm values schemas](https://helm.sh/docs/topics/charts/#schema-files),
[PVC access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes),
[CronJob timezone and concurrency](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/),
[init containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/),
[kubeconform](https://github.com/yannh/kubeconform).
