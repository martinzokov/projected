import type { CommandResult } from "./commands.js";

export interface OperateOptions {
  /** The service's base URL. */
  readonly url: string | undefined;
  /** The task's input, as JSON. Defaults to `{}`. */
  readonly input?: string | undefined;
  /** Bearer token of a principal with `projected:operate`. Defaults to `PROJECTED_OPERATOR_TOKEN`. */
  readonly token?: string | undefined;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

interface TaskInfo {
  readonly name: string;
  readonly description: string;
  readonly input: { readonly properties?: Record<string, { type?: string; enum?: unknown[] }>; readonly required?: string[] };
}

/** `{ handler: string, since?: string }` from a task's JSON Schema. */
function inputSummary(schema: TaskInfo["input"]): string {
  const fields = Object.entries(schema.properties ?? {}).map(([name, property]) => {
    const type = property.enum !== undefined ? property.enum.map((value) => JSON.stringify(value)).join(" | ") : (property.type ?? "unknown");
    return `${name}${schema.required?.includes(name) ? "" : "?"}: ${type}`;
  });
  return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
}

/**
 * `projected operate [task] --url <service> [--input <json>] [--token <token>]`: run an operator
 * task on a running service — `POST /operate/{task}` — and print its outcome. Without a task, list
 * the tasks the service offers.
 */
export async function operate(task: string | undefined, options: OperateOptions): Promise<CommandResult> {
  const name = task ?? "list-tasks";
  if (options.url === undefined) return { ok: false, lines: ["operate: name the service with --url <base url>, e.g. --url https://billing.internal"] };
  let input: unknown = {};
  if (options.input !== undefined) {
    try {
      input = JSON.parse(options.input);
    } catch {
      return { ok: false, lines: [`operate: --input must be JSON, e.g. --input '{"handler":"student-directory"}'`] };
    }
  }
  const token = options.token ?? process.env["PROJECTED_OPERATOR_TOKEN"];
  const url = `${options.url.replace(/\/+$/, "")}/operate/${name}`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(input),
    });
  } catch (error) {
    return { ok: false, lines: [`operate: cannot reach ${options.url}: ${(error as Error).message}`] };
  }
  const body = (await response.json().catch(() => undefined)) as
    | { status?: string; value?: unknown; title?: string; detail?: string }
    | undefined;

  if (response.ok && body?.status === "ok") {
    if (name === "list-tasks") {
      const tasks = (body.value as { tasks: TaskInfo[] }).tasks;
      const width = Math.max(...tasks.map((t) => t.name.length));
      return { ok: true, lines: tasks.map((t) => `${t.name.padEnd(width)}  ${inputSummary(t.input)}  ${t.description}`) };
    }
    return { ok: true, lines: JSON.stringify(body.value, null, 2).split("\n") };
  }
  const hint =
    response.status === 401
      ? " — pass a token with --token or PROJECTED_OPERATOR_TOKEN"
      : response.status === 403
        ? " — the token's principal needs the projected:operate permission"
        : response.status === 404 && body?.title === undefined
          ? ` — is ${options.url} a projected service?`
          : "";
  const what = body?.title === undefined ? `HTTP ${response.status}` : `${response.status} ${body.title}`;
  return { ok: false, lines: [`operate: ${name}: ${what}${body?.detail === undefined ? "" : `: ${body.detail}`}${hint}`] };
}
