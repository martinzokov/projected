import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Result, createApplication, defineCommand, defineContracts, z } from "@projected/application";
import { jwtAuthenticator, jwtSecuritySchemes } from "@projected/auth-jwt";
import { httpHandler, openApiDocument } from "@projected/http";
import { sequentialIds } from "@projected/testing";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";

const audience = "https://api.ledger.test";
let server: Server;
let issuer: string;
let signingKey: CryptoKey;
let publicJwk: JWK;
let requests = 0;

/** A stand-in issuer: an OpenID Connect discovery document and the key set it names. */
beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "key-1", alg: "ES256", use: "sig" };
  server = createServer((request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/openid-configuration") response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}jwks` }));
    else if (request.url === "/jwks") response.end(JSON.stringify({ keys: [publicJwk] }));
    else response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** A token from the issuer, unless told otherwise. */
const token = (claims: Record<string, unknown> = {}, options: { key?: CryptoKey; issuer?: string; audience?: string; expiresIn?: string } = {}) =>
  new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "key-1" })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setSubject((claims["sub"] as string | undefined) ?? "auth0|u-1")
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(options.key ?? signingKey);

const bearer = async (claims?: Record<string, unknown>, options?: Parameters<typeof token>[1]) => ({
  headers: { authorization: `Bearer ${await token(claims, options)}` },
});

describe("the JWT authenticator", () => {
  it("turns a verified token into a principal, with the permissions it carries", async () => {
    const authenticator = jwtAuthenticator({ issuer, audience });

    const principal = (await authenticator.authenticate(await bearer({ permissions: ["accounts:open", "transfers:make"], email: "a@bank.test" }))).unwrap();

    expect(principal).toMatchObject({ id: "auth0|u-1", kind: "user", permissions: ["accounts:open", "transfers:make"] });
    expect(principal?.claims["email"]).toBe("a@bank.test");
  });

  it("reads permissions from the OAuth scope when the token has no permissions claim", async () => {
    const principal = (await jwtAuthenticator({ issuer, audience }).authenticate(await bearer({ scope: "accounts:read transfers:make" }))).unwrap();

    expect(principal?.permissions).toEqual(["accounts:read", "transfers:make"]);
  });

  it("maps the issuer's own claims to permissions when told how", async () => {
    const authenticator = jwtAuthenticator({
      issuer,
      audience,
      permissions: (claims) => ((claims["roles"] as string[] | undefined)?.includes("teller") ? ["transfers:make"] : []),
    });

    const principal = (await authenticator.authenticate(await bearer({ roles: ["teller"] }))).unwrap();

    expect(principal?.permissions).toEqual(["transfers:make"]);
  });

  it("knows a client-credentials token for a service", async () => {
    const principal = (await jwtAuthenticator({ issuer, audience }).authenticate(await bearer({ sub: "payments-gateway", client_id: "payments-gateway" }))).unwrap();

    expect(principal?.kind).toBe("service");
  });

  it("treats an expired, forged, misdirected or foreign token as anonymous", async () => {
    const authenticator = jwtAuthenticator({ issuer, audience });
    const forger = (await generateKeyPair("ES256")).privateKey;

    const outcomes = await Promise.all(
      [
        bearer({}, { expiresIn: "-1m" }),
        bearer({}, { key: forger }),
        bearer({}, { audience: "https://another-api.test" }),
        bearer({}, { issuer: "https://elsewhere.test/" }),
      ].map(async (request) => (await authenticator.authenticate(await request)).unwrap()),
    );

    expect(outcomes).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("leaves requests without a bearer JWT anonymous, without asking the issuer", async () => {
    const authenticator = jwtAuthenticator({ issuer: "http://127.0.0.1:1/", audience });

    const none = await authenticator.authenticate({ headers: {} });
    const opaque = await authenticator.authenticate({ headers: { authorization: "Bearer an-opaque-session-token" } });

    expect([none.unwrap(), opaque.unwrap()]).toEqual([undefined, undefined]);
  });

  it("reports an issuer it cannot reach as unavailable, never as anonymous", async () => {
    const authenticator = jwtAuthenticator({ issuer: "http://127.0.0.1:1/", audience, timeoutMs: 500 });

    const outcome = await authenticator.authenticate(await bearer());

    expect(outcome.isErr() && outcome.error).toMatchObject({ _tag: "DependencyUnavailable", dependency: "jwt issuer" });
  });

  it("discovers the issuer's keys once, then verifies from them", async () => {
    const authenticator = jwtAuthenticator({ issuer, audience });
    const before = requests;

    for (let i = 0; i < 3; i++) (await authenticator.authenticate(await bearer())).unwrap();

    expect(requests - before).toBe(2);
  });

  it("verifies against keys it is given, with no issuer to ask", async () => {
    const authenticator = jwtAuthenticator({ issuer, audience, keys: { keys: [publicJwk] } });
    const before = requests;

    const principal = (await authenticator.authenticate(await bearer())).unwrap();

    expect(principal?.id).toBe("auth0|u-1");
    expect(requests).toBe(before);
  });

  it("decides access over HTTP from the permissions in the token", async () => {
    const Transfer = defineCommand({ type: "make-transfer", input: z.object({}), output: z.object({}), access: { permissions: ["transfers:make"] } });
    const app = createApplication(defineContracts({ name: "ledger", access: "authenticated", commands: [Transfer] }), {
      ids: sequentialIds(),
      commands: { "make-transfer@1": () => Result.ok({}) },
    });
    const handler = httpHandler(app, { authenticator: jwtAuthenticator({ issuer, audience }) });
    const post = async (authorization: string) =>
      (await handler(new Request("http://ledger.test/commands/make-transfer/version/1", { method: "POST", headers: { authorization } }))).status;

    const statuses = [await post(`Bearer ${await token({ permissions: ["transfers:make"] })}`), await post(`Bearer ${await token()}`), await post("")];

    expect(statuses).toEqual([200, 403, 401]);
  });

  it("documents bearer JWTs and the issuer's discovery document", () => {
    const document = openApiDocument(defineContracts({ name: "ledger", access: "authenticated" }), { securitySchemes: jwtSecuritySchemes({ issuer: "https://bank.eu.auth0.com/" }) });

    expect(document.components?.securitySchemes).toMatchObject({
      bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      openIdConnect: { type: "openIdConnect", openIdConnectUrl: "https://bank.eu.auth0.com/.well-known/openid-configuration" },
    });
  });
});
