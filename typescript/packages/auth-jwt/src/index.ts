/**
 * @projected/auth-jwt — authenticate projected requests with JSON Web Tokens from an OpenID
 * Connect or OAuth 2 issuer: Auth0, Clerk, Cognito, Keycloak, WorkOS, Entra ID, or your own.
 *
 * ```ts
 * const authenticator = jwtAuthenticator({ issuer: "https://school.eu.auth0.com/", audience: "https://api.school.example" });
 * const handler = httpHandler(app, { authenticator, openApi: { securitySchemes: jwtSecuritySchemes() } });
 * ```
 *
 * Infrastructure-only: wire it in `src/infrastructure/config`. Use cases see only the resulting
 * `Principal`, so swapping one issuer for another never touches them.
 */
import { DependencyUnavailable, Result, type Authenticator, type Principal } from "@projected/application";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload, type JWTVerifyGetKey } from "jose";

export type JwtClaims = JWTPayload & Readonly<Record<string, unknown>>;

export interface JwtAuthenticatorOptions {
  /** The `iss` every token must carry, e.g. `https://school.eu.auth0.com/`. */
  readonly issuer: string;
  /** The `aud` a token must include: this service's identifier at the issuer. */
  readonly audience: string | readonly string[];
  /**
   * Where the issuer's signing keys are. Defaults to the `jwks_uri` of the issuer's OpenID Connect
   * discovery document (`<issuer>/.well-known/openid-configuration`). Pass a key set itself to
   * verify against fixed keys — in tests, or with an issuer that publishes no discovery document.
   */
  readonly keys?: string | JSONWebKeySet;
  /**
   * What the principal may do. Defaults to the `permissions` claim (Auth0's RBAC), else the
   * `scope` (OAuth) or `scp` (Entra ID) claim split on spaces. Map the issuer's roles or scopes
   * to the permissions your operations require here.
   */
  readonly permissions?: (claims: JwtClaims) => readonly string[];
  /**
   * Whether the token is a user's or a service's. Defaults to `"service"` for client-credentials
   * tokens — `sub` equal to `client_id`, Auth0's `gty: "client-credentials"` or `…@clients` —
   * and `"user"` otherwise.
   */
  readonly kind?: (claims: JwtClaims) => Principal["kind"];
  /** Signature algorithms accepted. Defaults to RS256, PS256, ES256 and EdDSA. */
  readonly algorithms?: readonly string[];
  /** Leeway for `exp` and `nbf`, for clocks that disagree a little. Defaults to 5 s. */
  readonly clockToleranceSeconds?: number;
  /** How long fetching the discovery document or the keys may take. Defaults to 5 s. */
  readonly timeoutMs?: number;
}

const BEARER = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/i;

/** Errors that mean the token is not good — expired, forged, for another audience — rather than that the issuer could not be asked. */
const REJECTED = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
]);

const strings = (value: unknown): string[] =>
  typeof value === "string" ? value.split(" ").filter((part) => part !== "") : Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];

const defaultPermissions = (claims: JwtClaims): string[] =>
  Array.isArray(claims["permissions"]) ? strings(claims["permissions"]) : strings(claims["scope"] ?? claims["scp"]);

const defaultKind = (claims: JwtClaims): Principal["kind"] =>
  claims["gty"] === "client-credentials" ||
  (typeof claims["client_id"] === "string" && claims.sub === claims["client_id"]) ||
  (typeof claims.sub === "string" && claims.sub.endsWith("@clients"))
    ? "service"
    : "user";

/**
 * An {@link Authenticator} for `Authorization: Bearer <jwt>`. A token that verifies — signed by
 * the issuer's key, from the issuer, for this audience, not expired — becomes a principal: `sub`
 * as its id, and its claims. A missing, malformed, expired or forged token is anonymous, so
 * whether that may proceed is each operation's `access` rule. An issuer that cannot be reached is
 * `DependencyUnavailable`: the caller gets a 503, not a 401 it would wrongly act on.
 */
export function jwtAuthenticator(options: JwtAuthenticatorOptions): Authenticator {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const permissionsOf = options.permissions ?? defaultPermissions;
  const kindOf = options.kind ?? defaultKind;
  const unavailable = (message: string, cause?: unknown) =>
    Result.err(new DependencyUnavailable({ dependency: "jwt issuer", message: `jwt issuer ${options.issuer}: ${message}`, cause }));

  let keySet: JWTVerifyGetKey | undefined =
    typeof options.keys === "object" ? createLocalJWKSet(options.keys) : typeof options.keys === "string" ? remote(options.keys) : undefined;
  function remote(url: string): JWTVerifyGetKey {
    return createRemoteJWKSet(new URL(url), { timeoutDuration: timeoutMs });
  }

  /** The issuer's keys, found through discovery the first time; a failed discovery is tried again on the next request. */
  const keys = async (): Promise<Result<JWTVerifyGetKey, DependencyUnavailable>> => {
    if (keySet !== undefined) return Result.ok(keySet);
    const discovery = `${options.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    try {
      const response = await fetch(discovery, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return unavailable(`discovery answered ${response.status}`);
      const document = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
      if (document.issuer !== options.issuer) return unavailable(`discovery names another issuer: ${String(document.issuer)}`);
      if (typeof document.jwks_uri !== "string") return unavailable("discovery names no jwks_uri");
      keySet = remote(document.jwks_uri);
      return Result.ok(keySet);
    } catch (cause) {
      return unavailable(`cannot read ${discovery}`, cause);
    }
  };

  return {
    authenticate: async ({ headers }) => {
      const token = BEARER.exec(headers["authorization"] ?? "")?.[1];
      // Not a JWT: someone else's credentials, or none.
      if (token === undefined) return Result.ok(undefined);
      const found = await keys();
      if (found.isErr()) return Result.err(found.error);
      try {
        const { payload } = await jwtVerify(token, found.value, {
          issuer: options.issuer,
          audience: typeof options.audience === "string" ? options.audience : [...options.audience],
          algorithms: [...(options.algorithms ?? ["RS256", "PS256", "ES256", "EdDSA"])],
          clockTolerance: options.clockToleranceSeconds ?? 5,
        });
        const claims = payload as JwtClaims;
        if (typeof claims.sub !== "string" || claims.sub === "") return Result.ok(undefined);
        return Result.ok({ id: claims.sub, kind: kindOf(claims), permissions: [...permissionsOf(claims)], claims });
      } catch (cause) {
        const code = (cause as { code?: unknown }).code;
        if (typeof code === "string" && REJECTED.has(code)) return Result.ok(undefined);
        return unavailable("cannot verify tokens", cause);
      }
    },
  };
}

/**
 * OpenAPI security schemes for the generated document: bearer JWTs and, given the issuer, its
 * OpenID Connect discovery document, which lets tools sign a caller in.
 */
export function jwtSecuritySchemes(options: { readonly issuer?: string } = {}): Record<string, unknown> {
  return {
    bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "An access token from the service's issuer." },
    ...(options.issuer === undefined
      ? {}
      : { openIdConnect: { type: "openIdConnect", openIdConnectUrl: `${options.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration` } }),
  };
}
