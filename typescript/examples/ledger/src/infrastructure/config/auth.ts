import { jwtAuthenticator, jwtSecuritySchemes } from "@projected/auth-jwt";

/**
 * Callers sign in at the bank's identity provider — any OpenID Connect issuer — and send its
 * access token as `Authorization: Bearer <jwt>`. Their permissions come from the token's
 * `permissions` claim, or its `scope`: `accounts:manage` for staff, `cash:handle` for tellers,
 * `projected:operate` for operators; customers need none.
 *
 *   JWT_ISSUER    the issuer, e.g. https://bank.eu.auth0.com/
 *   JWT_AUDIENCE  this service's identifier at the issuer
 *   JWT_JWKS_URL  where the signing keys are, when the issuer publishes no discovery document
 */
export function auth(env: NodeJS.ProcessEnv) {
  const { JWT_ISSUER: issuer, JWT_AUDIENCE: audience, JWT_JWKS_URL: keys } = env;
  if (issuer === undefined || audience === undefined) {
    throw new Error("Set JWT_ISSUER and JWT_AUDIENCE to the identity provider whose tokens ledger accepts: it serves no one anonymously.");
  }
  return {
    authenticator: jwtAuthenticator({ issuer, audience, ...(keys === undefined ? {} : { keys }) }),
    securitySchemes: jwtSecuritySchemes({ issuer }),
  };
}
