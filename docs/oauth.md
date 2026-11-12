# Personal OAuth for the Node runtime

The Node server can run behind Cloudflare Access Managed OAuth using its
existing tunnel. Access is the OAuth authorization server; GeoBS-MCP is the
protected resource. No passwords, login database, OAuth signing keys or token
issuer are implemented in this application. This mode applies to `src/node/`,
not to the retained Worker entry point. Anonymous deployments remain supported
unless the operator explicitly enables the protected mode.

## Trust boundaries

```text
MCP client -- OAuth access token --> Cloudflare Access -- signed assertion --> Node /mcp
                  ^                       |
                  +-- personal login -----+
```

Access handles discovery, client registration, authorization code/PKCE and
resource binding, personal login, policies, grants and token refresh. It
resolves the client's opaque access token and injects `Cf-Access-Jwt-Assertion`.
The Node server verifies that JWT using `jose` and the configured team's
public signing keys. It checks RS256, issuer, the dedicated application's AUD,
required timestamps, token lifetime and a personal application identity.
Org-session tokens and non-identity/service tokens are rejected. Cookies,
plain identity headers, forwarded headers and `Authorization` alone never
authenticate a direct origin request. Client-supplied key/issuer URLs are not
used for discovery or verification.

Use a dedicated Access application for this MCP resource. Its AUD grants the
five existing read-only tools; it must not be shared with unrelated services.
OAuth scope checks belong to Access's authorization boundary. Access does not
guarantee a `scope` claim in the origin assertion, so this server does not
invent per-tool scope enforcement from that assertion. Check actual published
scopes, resource binding and refresh behavior in the provider/client pilot.

## Configure

Create the Zero Trust organization and the personal identity provider using
the provider's supported setup. Verify available entitlements before enabling
features. Configure an explicit person/group Allow policy, not a service-token
or Bypass rule. A one-time email PIN is not proof of MFA. Use a suitable IdP/MFA
policy when MFA is required.

For the dedicated self-hosted Access application, enable Managed OAuth,
restrict dynamic registration to the clients' actual callback URIs, and disable
unneeded localhost/loopback registrations. Configure a short OAuth access-token
lifetime (for example five minutes) and an application/policy JWT lifetime of
at most fifteen minutes. Longer refresh grants need an explicit operator
decision. Re-read the resulting configuration rather than assuming defaults.

Example non-secret Node settings:

```text
GEOBS_AUTH_MODE=cloudflare-access
GEOBS_ACCESS_ISSUER=https://your-team.cloudflareaccess.com
GEOBS_ACCESS_AUDIENCE=<64-character application AUD tag>
GEOBS_OAUTH_RESOURCE=https://geo.example.test/mcp
GEOBS_OAUTH_AUTHORIZATION_SERVER=<exact issuer from Access OAuth metadata>
GEOBS_ACCESS_MAX_TOKEN_LIFETIME_SECONDS=900
```

Copy the OAuth authorization-server identifier exactly, including its trailing
slash if present. It is distinct from the Access JWT issuer and must agree
with the provider's actual OAuth metadata. Set `GEOBS_ALLOWED_HOSTS` and
`GEOBS_ALLOWED_ORIGINS` as before; missing Origin is normal for server-side
clients but never bypasses JWT verification. Restrict the listener to the
connector's loopback/private route and keep administrative access private.

Partial auth settings, unsupported modes or invalid URLs cause startup failure.
`GEOBS_AUTH_MODE=none` (the default) is allowed only without Access settings.
Treat removal of a deployed auth configuration as a security-sensitive change.
Keep these settings outside the image/release; never distribute the GeoBS
upstream key or origin JWT to visitors.

## Route policy

| Route | Node behavior in protected mode |
| --- | --- |
| `/mcp` and configured public-prefix alias | All methods except OPTIONS require a verified personal assertion before body buffering or MCP dispatch. |
| OPTIONS on `/mcp` | Restricted CORS preflight; no tool execution or authentication bypass. |
| `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/<public MCP path>` | Public resource metadata, referencing the configured authorization server. |
| OAuth authorization-server metadata, registration, login and token routes | Served by Access, not implemented or proxied by Node. |
| `/health/live`, `/health/ready` | Public minimal health; readiness checks only local catalog validity, not user credentials or upstream availability. |
| `/docs`, local assets, `/openapi.json` | Public documentation, with authenticated MCP operations described in OpenAPI. No tool invocation is public. |

Tunnel/gateway rules must expose provider-owned discovery/login routes as
required by Access, plus Node resource metadata and the intended routes. Protect
every public MCP alias with the same Access application and preserve streaming.
Unlisted paths remain unavailable. Health/monitoring probes need no shared
service token; do not weaken `/mcp` authentication for a probe.

Swagger can use an authenticated same-origin Access browser session or an
OAuth access token at the public gateway. Do not paste an origin assertion
or GeoBS API key into Swagger. An expired browser session may need another
interactive login before Try it out works again.

## Client acceptance and revocation

For ChatGPT choose OAuth rather than mixed/anonymous authentication. Use the
exact production redirect URI shown by the connection management UI. Its
callback form depends on authorization-server issuer identification; do not
guess a callback ID. For Claude use the actual connector's supported client
registration method and callback. Verify discovery advertises PKCE S256 and
that issuer/resource identifiers match exactly. Do not label a raw HTTP or
SDK check as a successful personal ChatGPT/Claude login.

Test each client with an allowed person, a denied person and no token. Check
discovery, login, PKCE, registration restrictions, five-tool discovery, a cached
metadata query, streaming, token expiry/refresh and removal of permission.
Test wrong issuer/audience/signature, future or expired tokens, injected
identity headers, wrong Hosts/Origins and every alternate origin path.

Node caches public JWKS for five minutes, with a three-second fetch timeout
and a thirty-second rotation fetch cooldown. It does not cache authorization
success. Each request rechecks token time claims with five seconds of clock
tolerance. Tokens whose signed lifetime exceeds the configured maximum are
rejected. An already-issued signed assertion can remain valid at a direct
origin until expiry: local cryptographic verification is not online revocation.
The maximum configured lifetime is fifteen minutes, plus clock tolerance;
an already-running exchange may still finish. Access's public-edge revocation
may be faster; measure actual behavior before promising a shorter delay.
Removing only a browser cookie is not a complete token-revocation test.

## Build, recovery and evidence

Run `npm run check`, `npm run build:node`, `npm run test:node-build` and
`node scripts/smoke-node.mjs dist/node --access`. Unit tests use synthetic signed
tokens and mocked public keys; the extra compiled smoke checks anonymous
rejection, metadata, health and OAuth-aware Swagger without external services.
Neither test creates provider resources or completes a real login.

Record provider settings, application/policy/IdP references, allowed callback
URIs, selected lifetimes, public routes, release hashes and measured client
results in private operational evidence. Include Node configuration and its
matching release in the established backup process. Provider configuration
needs an explicit reconstruction record; a Node filesystem backup does not
restore Access policies, provider signing keys or user grants. After rebuilding
provider resources, recheck AUD/issuer values and require client reauthorization.

Keep a private administrative recovery path independent of OAuth. Before
rolling back to a release without origin verification, close the public MCP
route or preserve an independently verified protection layer. Do not silently
restore anonymous public tools after an auth failure.

## Official references

- [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [Access JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Access application token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Access sessions and revocation](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- [ChatGPT MCP authentication](https://developers.openai.com/plugins/build/auth)
- [Claude remote MCP connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
