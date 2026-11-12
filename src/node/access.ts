import { createRemoteJWKSet, errors, jwtVerify } from "jose";

// Fixed vocabulary for operator diagnostics. A reason never carries a claim
// value, identity, token fragment, key URL or library message.
export type AccessRejection = "missing" | "malformed" | "keys_unavailable" | "unknown_key" | "signature" |
  "issuer" | "audience" | "expired" | "not_yet_valid" | "lifetime" | "token_type" | "identity" | "claims";
// `claim` names which fixed claim or header a "claims"/"identity" refusal is
// about and whether it was absent or unusable; it is never a claim value.
export type AccessDecision = { ok: true } | { ok: false; reason: AccessRejection; claim?: string };

const reportableClaims = ["typ", "exp", "iat", "nbf", "sub", "email", "type"];
function claimDetail(claim: unknown, state: "missing" | "invalid") {
  // The name comes from this module's own checks; anything else is withheld.
  return typeof claim === "string" && reportableClaims.includes(claim) ? { claim: `${claim}:${state}` } : {};
}

function rejection(error: unknown): { ok: false; reason: AccessRejection; claim?: string } {
  if (error instanceof errors.JWTExpired) return { ok: false, reason: error.claim === "exp" ? "expired" : "lifetime" };
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "iss") return { ok: false, reason: "issuer" };
    if (error.claim === "aud") return { ok: false, reason: "audience" };
    if (error.reason === "check_failed" && (error.claim === "nbf" || error.claim === "iat")) return { ok: false, reason: "not_yet_valid" };
    return { ok: false, reason: "claims", ...claimDetail(error.claim, error.reason === "missing" ? "missing" : "invalid") };
  }
  if (error instanceof errors.JWKSNoMatchingKey) return { ok: false, reason: "unknown_key" };
  if (error instanceof errors.JWSSignatureVerificationFailed) return { ok: false, reason: "signature" };
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid ||
      error instanceof errors.JOSEAlgNotAllowed || error instanceof errors.JOSENotSupported) return { ok: false, reason: "malformed" };
  // Timeouts, non-200 key responses, invalid key documents and network errors.
  return { ok: false, reason: "keys_unavailable" };
}

export type AccessConfiguration = {
  issuer: string;
  audience: string;
  resource: string;
  authorizationServer: string;
  maxTokenLifetimeSeconds: number;
};

const accessSettings = ["GEOBS_ACCESS_ISSUER", "GEOBS_ACCESS_AUDIENCE", "GEOBS_OAUTH_RESOURCE",
  "GEOBS_OAUTH_AUTHORIZATION_SERVER", "GEOBS_ACCESS_MAX_TOKEN_LIFETIME_SECONDS"] as const;

function httpsUrl(value: string | undefined, name: string, allowBareOrigin = false) {
  if (!value) throw new Error(`${name} is required in cloudflare-access mode.`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.href !== value && !(allowBareOrigin && value === url.origin))) {
    throw new Error(`${name} must be a canonical HTTPS URL without credentials, query or fragment.`);
  }
  return url;
}

export function accessConfiguration(env: Record<string, string | undefined>): AccessConfiguration | undefined {
  const mode = env.GEOBS_AUTH_MODE ?? "none";
  if (mode === "none") {
    // An incomplete deployment must not silently turn authentication off.
    if (accessSettings.some(name => env[name] !== undefined)) throw new Error("Access settings require GEOBS_AUTH_MODE=cloudflare-access.");
    return undefined;
  }
  if (mode !== "cloudflare-access") throw new Error("Unsupported GEOBS_AUTH_MODE.");
  const issuer = env.GEOBS_ACCESS_ISSUER;
  if (!issuer || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer)) {
    throw new Error("GEOBS_ACCESS_ISSUER must be the exact HTTPS Cloudflare Access team origin, without a trailing slash.");
  }
  const audience = env.GEOBS_ACCESS_AUDIENCE;
  if (!audience || !/^[a-f0-9]{64}$/.test(audience)) throw new Error("GEOBS_ACCESS_AUDIENCE must be the application's AUD tag.");
  const resource = httpsUrl(env.GEOBS_OAUTH_RESOURCE, "GEOBS_OAUTH_RESOURCE");
  if (!resource.pathname.endsWith("/mcp")) throw new Error("GEOBS_OAUTH_RESOURCE must identify the public /mcp endpoint.");
  httpsUrl(env.GEOBS_OAUTH_AUTHORIZATION_SERVER, "GEOBS_OAUTH_AUTHORIZATION_SERVER", true);
  const lifetime = env.GEOBS_ACCESS_MAX_TOKEN_LIFETIME_SECONDS ?? "900";
  if (!/^[1-9][0-9]*$/.test(lifetime) || Number(lifetime) < 60 || Number(lifetime) > 900) {
    throw new Error("GEOBS_ACCESS_MAX_TOKEN_LIFETIME_SECONDS must be between 60 and 900.");
  }
  // OAuth issuer identifiers use exact matching: do not add/remove a slash.
  return { issuer, audience, resource: resource.href, authorizationServer: env.GEOBS_OAUTH_AUTHORIZATION_SERVER!,
    maxTokenLifetimeSeconds: Number(lifetime) };
}

export function createAccessGuard(config: AccessConfiguration) {
  // Never follow a token-controlled iss/jku/x5u. Key rotation is resolved only
  // against the configured team, with bounded timeout/cache and fetch cooldown.
  const keys = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), {
    timeoutDuration: 3_000, cacheMaxAge: 300_000, cooldownDuration: 30_000
  });
  const resource = new URL(config.resource);
  const metadataPath = `/.well-known/oauth-protected-resource${resource.pathname}`;
  return {
    metadataPath,
    metadata: { resource: config.resource, authorization_servers: [config.authorizationServer],
      bearer_methods_supported: ["header"], resource_name: "GeoBS MCP" },
    challenge: `Bearer resource_metadata="${resource.origin}${metadataPath}"`,
    // Distinguishes "no assertion" (the request did not pass the gateway, so
    // an OAuth challenge is useful) from "assertion refused" (the gateway
    // already authenticated the caller; another login cannot repair an origin
    // or provider configuration mismatch).
    async verify(assertion: string | undefined): Promise<AccessDecision> {
      if (!assertion) return { ok: false, reason: "missing" };
      // Duplicated headers are joined with commas by Node and fail this shape.
      // Cookies, Authorization and unsigned identity/forwarded headers are never
      // a substitute for this cryptographically verified application assertion.
      if (assertion.length > 12_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(assertion)) {
        return { ok: false, reason: "malformed" };
      }
      try {
        // Signature, issuer, the dedicated application AUD and expiry are the
        // security boundary. The provider does not promise a `typ` header,
        // `nbf` or `type` on every assertion it forwards, so those are
        // verified whenever present instead of being demanded.
        const { payload, protectedHeader } = await jwtVerify(assertion, keys, {
          issuer: config.issuer, audience: config.audience, algorithms: ["RS256"],
          requiredClaims: ["exp", "iat", "sub", "email"],
          maxTokenAge: config.maxTokenLifetimeSeconds, clockTolerance: 5
        });
        if (protectedHeader.typ !== undefined && !/^(application\/)?jwt$/i.test(protectedHeader.typ)) {
          return { ok: false, reason: "claims", claim: "typ:invalid" };
        }
        // Org and non-identity/service tokens do not grant personal MCP access.
        // The dedicated app AUD is the permission boundary for all five
        // read-only tools. Access enforces OAuth scopes/policies at its edge;
        // it does not promise an OAuth scope claim in the origin assertion.
        if (payload.type !== undefined && payload.type !== "app") return { ok: false, reason: "token_type" };
        if (typeof payload.sub !== "string" || payload.sub.length === 0) return { ok: false, reason: "identity", claim: "sub:invalid" };
        if (typeof payload.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(payload.email)) return { ok: false, reason: "identity", claim: "email:invalid" };
        if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp <= payload.iat ||
            payload.exp - payload.iat > config.maxTokenLifetimeSeconds) return { ok: false, reason: "lifetime" };
        return { ok: true };
      } catch (error) {
        // No JWT, identity, claim value, key URL or library message leaves
        // this function; only the fixed reason code and claim name do.
        return rejection(error);
      }
    },
    async accepts(assertion: string | undefined): Promise<boolean> {
      return (await this.verify(assertion)).ok;
    }
  };
}
