import { serve } from "@hono/node-server";
import type { Logger } from "@projected/application";
import { CORS_HEADERS, HEADERS, payloadTooLarge, type FetchHandler } from "@projected/http";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

export interface WebOptions {
  /** Origins whose browsers may call the service, and sign in. None: the same origin only. */
  readonly corsOrigins: readonly string[];
  /** Larger request bodies get 413. Defaults to 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Where each request is logged, with its status and message ids. Health probes are not. */
  readonly log?: Logger;
}

/** The origins listed in CORS_ORIGINS, comma-separated: `https://app.example.com,https://admin.example.com`. */
export const corsOrigins = (env: NodeJS.ProcessEnv): string[] => (env.CORS_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter((origin) => origin !== "");

/**
 * The service on the web: the projected handler behind Hono's middleware — a request log, security
 * headers, CORS for the origins listed, a body size limit. Add middleware of your own here, before
 * the handler; access rules, idempotency and tracing are the handler's, so that messaging gets them
 * too.
 */
export function web(api: FetchHandler, options: WebOptions): Hono {
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const app = new Hono();
  const log = options.log;
  if (log !== undefined) {
    app.use(async (c, next) => {
      const started = performance.now();
      await next();
      if (c.req.path.startsWith("/health")) return;
      log.info("request", {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms: Math.round(performance.now() - started),
        message_id: c.res.headers.get(HEADERS.messageId) ?? undefined,
        correlation_id: c.res.headers.get(HEADERS.correlationId) ?? undefined,
      });
    });
  }
  app.use(secureHeaders());
  if (options.corsOrigins.length > 0) {
    app.use(
      cors({
        origin: [...options.corsOrigins],
        credentials: true,
        allowHeaders: [...CORS_HEADERS.allow],
        exposeHeaders: [...CORS_HEADERS.expose],
        maxAge: 600,
      }),
    );
  }
  app.use(bodyLimit({ maxSize: maxBodyBytes, onError: () => payloadTooLarge(maxBodyBytes) }));
  app.all("*", (c) => api(c.req.raw));
  return app;
}

/** Serve `app` on Node, as a server `shutdownGracefully` can close. */
export function listen(app: Hono, port: number): Promise<{ readonly url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port }, (info) =>
      resolve({
        url: `http://localhost:${info.port}`,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      }),
    );
  });
}
