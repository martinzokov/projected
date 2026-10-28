import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchHandler } from "./server.js";

/** Node's HTTP server for a projected handler: `import { serve } from "@projected/http/node"`. */

export interface ServeOptions {
  /** Defaults to 3000. Use 0 for a random free port. */
  readonly port?: number;
  /** Defaults to `0.0.0.0`. */
  readonly hostname?: string;
  /** Requests with larger bodies get 413. Defaults to 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Called with errors thrown by the handler itself (not business or protocol errors). */
  readonly onError?: (error: unknown) => void;
}

export interface RunningServer {
  /** `http://host:port` the server listens on. */
  readonly url: string;
  close(): Promise<void>;
}

/** Run a {@link FetchHandler} on Node's built-in HTTP server. */
export function serve(handler: FetchHandler, options: ServeOptions = {}): Promise<RunningServer> {
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const server = createServer((req, res) => {
    void respond(handler, req, res, maxBodyBytes).catch((error: unknown) => {
      options.onError?.(error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ type: "urn:projected:problem:internal-error", title: "Internal error", status: 500 }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3000, options.hostname ?? "0.0.0.0", () => {
      const { port } = server.address() as AddressInfo;
      const host = options.hostname === undefined || options.hostname === "0.0.0.0" ? "localhost" : options.hostname;
      resolve({
        url: `http://${host}:${port}`,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

async function respond(handler: FetchHandler, req: IncomingMessage, res: ServerResponse, maxBodyBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBodyBytes) {
      res.writeHead(413, { "content-type": "application/problem+json", connection: "close" });
      res.end(JSON.stringify({ type: "urn:projected:problem:payload-too-large", title: "Payload too large", status: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  });
  const response = await handler(request);
  // One entry per name would keep only the last cookie: Set-Cookie is the header that repeats.
  const outgoing: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") outgoing[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) outgoing["set-cookie"] = cookies;
  res.writeHead(response.status, outgoing);
  res.end(Buffer.from(await response.arrayBuffer()));
}
