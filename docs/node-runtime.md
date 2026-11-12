# Node.js runtime and portable release

The Node adapter retains the same five tool registrations, schemas and
read-only `/mcp` contract, with optional personal authentication at a trusted
Cloudflare Access gateway. The existing Worker entry point, KV binding
and deployment command remain available. No migration occurs when building.

For a production Docker image and Kubernetes integration guidance, see
[Standalone container](container.md). The native runtime remains available.

## Build

Use **Node.js 24.20.0**, pinned in `.node-version`, and the committed npm lockfile.
On a build machine run `npm ci`, `npm run check`, then `npm run build:node`.
`npm run release:node` requires a clean committed checkout and produces a portable
archive and adjacent SHA-256 file under `dist/releases/`. It includes bundled
JavaScript dependencies, their licenses, source archive, lockfile, this guide,
`release.json` and per-file checksums. The target needs no npm installation.
Ordinary `build:node` also works without a Git checkout; its manifest then uses
`null` for commit and source cleanliness instead of claiming pinned provenance.
The release does not include Node itself, credentials, catalog data or logs.
Rebuild using its source archive, exact Node version and lockfile; builds need
access to the locked dependencies. Archive metadata may differ between builds.
Run `npm run test:node-build` after the local build, or
`node scripts/smoke-node.mjs /path/to/extracted-release` against an extracted
archive. This uses a synthetic temporary catalog and loopback port 8080, checks
the compiled entrypoint with modern JSON and legacy SSE, and contacts no GeoBS
service. Port 8080 must be free. It is not an actual connected-chat acceptance.

The target is **Ubuntu 24.04 amd64**. Install the pinned Node Linux x64 runtime
through the operator's approved maintenance path and verify the upstream checksum.
Supply working CA certificates, DNS and time synchronisation. A build/test on
another OS is not proof of successful execution on the target guest.

## Entrypoints and operator configuration

Run as an unprivileged service account; the entrypoints reject UID 0 and a
different Node version. The native listener defaults to **127.0.0.1:8080**;
set `GEOBS_BIND_ADDRESS` to an explicit numeric IP for other bindings.
The container image sets it to `0.0.0.0` for Pod/service access.

```text
node /opt/geobs-mcp/current/server.mjs
node /opt/geobs-mcp/current/refresh.mjs
```

| Setting | Contract |
| --- | --- |
| `GEOBS_BIND_ADDRESS` | Numeric IPv4/IPv6 listener; native default `127.0.0.1`, container default `0.0.0.0`. Port 8080; does not relax Host/Origin checks |
| `GEOBS_CATALOG_PATH` | Absolute path; default `/var/lib/geobs-mcp/catalog/ogc-catalog.v1.json` |
| `GEOBS_PUBLIC_BASE_PATH` | Optional public path, e.g. `/geobs-mcp/v1`; adds versioned documentation/MCP aliases while preserving internal routes. See [gateway guide](public-api.md). |
| `GEOBS_ALLOWED_HOSTS` | Comma-separated exact Host authorities, including non-default ports. Defaults `127.0.0.1:8080,localhost:8080`; explicitly add the public connector Host if preserved |
| `GEOBS_ALLOWED_ORIGINS` | Comma-separated exact allowed origins. Defaults `http://127.0.0.1:8080,http://localhost:8080`; HTTPS required for non-loopback origins; no wildcard |
| `GEOBS_MAX_CONCURRENT_REQUESTS` | Maximum parallel `/mcp` exchanges per process (1–9999, default 32). Excess requests receive HTTP 503 with `Retry-After: 1` before their body is read. |
| `GEOBS_API_KEY_FILE` | Optional absolute protected credential-file path; takes precedence over systemd credentials |
| `CREDENTIALS_DIRECTORY` | Alternatively systemd `LoadCredential=GEOBS_API_KEY:…` supplies a file named `GEOBS_API_KEY` here |

For a connector preserving a public hostname, explicitly configure e.g.
`GEOBS_ALLOWED_HOSTS=geo.example.test,127.0.0.1:8080` and
`GEOBS_ALLOWED_ORIGINS=https://geo.example.test`. Host comparison lowercases
the authority but keeps its port significant; `geo.example.test:443` is a
different configured authority. Origin comparison uses the complete exact
origin. Replace the example with the operator's approved hostname.

No credential values belong in config, command lines, releases or logs. Missing
credentials leave key-dependent tools unavailable; public discovery remains
possible. The app does not read a `.env` or credential environment value.
Incoming forwarded headers are ignored. Absent Origin is allowed for non-browser
MCP clients; a present unlisted Origin or Host is rejected. Reverse proxies must
preserve/configure the intended Host and stream responses without buffering.
Without an explicit auth configuration the Node endpoint remains anonymous.
For protected operation, see [personal OAuth](oauth.md). `/` is liveness only. Readiness fails when
the catalog is missing, invalid, corrupt or over 14 days old; it does not claim
that upstream credentials work.
HTTP bodies are capped at 1,000,000 bytes; headers at 16 KiB. Logs are JSON lines
on stdout, using the existing event schema without inputs, responses or secrets.
`/health/live` returns only `{"status":"ok"}`. `/health/ready` returns
`{"status":"ok"}` or HTTP 503 `{"status":"not_ready"}`. These checks read
only local state and never probe upstream. Ingress may publish both minimal
health paths alongside `/mcp`; all other paths should return 404 at ingress.
The existing `/` liveness response can remain internal.

## Catalog and refresh

The refresh CLI fetches only the existing public GeoBS collection source.
Normal operation needs only `api.geo.bs.ch` over HTTPS for its domain APIs.
The service never downloads STAC assets and needs no LLM provider connection.
The scheduled refresh is **Wednesday 03:00 Europe/Zurich**, supplied by the
operator's calendar timer with `Persistent=true`. The CLI intentionally works
outside that exact minute for initial population and missed-calendar catch-up;
it does not provide retries or create a timer itself. Initialise it before
declaring readiness. The refresher needs write permission on the catalog
directory; the application only needs read permission. Run both services as the
same unprivileged account because replacement files are private mode 0600;
the application service can still mount the directory read-only in its sandbox.

For Kubernetes, the [generic Helm chart](../charts/geobs-mcp/README.md) supplies
the schedule and persistent mounts. Its init container uses
`node /app/refresh.mjs --ensure`: reuse a valid (including usable stale) snapshot,
populate a missing or refresh an expired one. Corruption still fails closed.
Without `--ensure`, the CLI always attempts the normal validated refresh.

The active snapshot is written to a unique same-directory 0600 temporary file,
synced, renamed and (on Linux) the containing directory synced. Refresh locking
uses exclusive creation of `<catalog>.refresh.lock`. Existing locks are never
taken over automatically, regardless of age: a timeout or old modification
time does not prove that the writer has exited. A crash may leave a lock.
Before removing that exact leftover lock, stop all refreshers (including
CronJobs and init containers sharing the volume) and verify that its owner has
exited. PID values are diagnostic only and may refer to another pod's namespace.
Resume refreshers only after recovery; do not remove a live writer's lock.
Failed fetches,
pagination, unexpected counts and invalid snapshots keep the last good file.
Readers validate schema and canonical collection hash; never edit the active
file in place. Corrupt snapshots require operator repair/repopulation, not a
silent public fallback. Preserve `fetchedAt` during recovery.

Existing bounds remain: at most 12,000,000 UTF-8 bytes, 20,000 unique collections,
25-second upstream metadata timeout, manual review for count changes outside
50–200%. Up to 7 days fresh; over 7 through 14 days stale but usable; over
14 days rejected by catalog-dependent paths. No user/session/chat state is kept.

## Install, rollback and recovery

These are operator instructions, not an installer or deployment command.

1. Verify the adjacent archive checksum, extract into a new immutable
   `/opt/geobs-mcp/releases/<release-id>/` directory and run `sha256sum -c SHA256SUMS`.
   Check `release.json`, runtime, ownership and configuration before use.
2. Prepare protected config/credentials, state directory, service and calendar
   using the approved infrastructure plan. Keep secrets outside release trees.
3. Populate/validate the catalog administratively. Point `current` atomically
   to the new release and restart the service in the approved cutover window.
4. Check loopback health/readiness, JSON/SSE and actual connected clients through
   the intended ingress. The old Worker/KV/cron stays available until acceptance.

Rollback means restoring the previous compatible release/config reference and
restarting; preserve its matching credentials and valid catalog. For a failed
client cutover, an old anonymous release or Worker is not an authenticated
fallback: keep the public route closed until protection is restored. Never delete the
old Worker or KV merely because the Node build passed. Source and application
release files must be available for recovery, rather than just a Git hash.
Back up the release, effective configuration/units, protected required
credentials and last good catalog through the operator's established backup
mechanism. Rebuilding the OS/runtime/network is a separate infrastructure step.
