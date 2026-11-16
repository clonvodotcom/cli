// Tools: the list from GET /v1/tools, command-line words turned into arguments by each tool's JSON Schema, and calls
// that follow long-running jobs until they finish.
import { readFile } from "node:fs/promises";
import { ClonvoError, type Client } from "./api.js";

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  default?: unknown;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  input_schema: JsonSchema;
  providers: string[];
  available_providers: string[];
}

export interface ToolJob {
  id: string;
  object: "tool.job";
  tool: string;
  status: "running" | "completed" | "failed" | "cancelled";
  provider: string | null;
  poll_after_ms?: number;
  result?: unknown;
  error?: { message: string; code: string | null };
  usage?: { cost: number; charged: number };
}

export interface ToolCall {
  id: string;
  tool: string;
  provider: string;
  result: unknown;
  usage: { cost: number; charged: number };
  cached?: true;
}

export async function listTools(client: Client) {
  const { data } = await client.request<{ data: Tool[] }>("GET", "/v1/tools");
  return data.data;
}

/** web-search, WEB_SEARCH and web_search all name the same tool. */
export const toolKey = (name: string) => name.trim().toLowerCase().replace(/-/g, "_");

/** Edit distance, for "did you mean". */
export function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j]!;
      row[j] = next;
    }
  }
  return row[b.length]!;
}

/** Tools whose id, or a word of it, is within two edits of the name. */
export function similarTools(tools: Tool[], name: string) {
  const key = toolKey(name);
  const score = (t: Tool) => Math.min(distance(key, t.id), ...t.id.split("_").map((part) => distance(key, part) + 1));
  return tools
    .map((t) => ({ id: t.id, d: score(t) }))
    .filter((x) => x.d <= 2)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.id);
}

export function findTool(tools: Tool[], name: string) {
  const key = toolKey(name);
  return tools.find((t) => t.id === key) ?? null;
}

const typeOf = (schema: JsonSchema | undefined) => {
  const t = schema?.type;
  return (Array.isArray(t) ? t.find((x) => x !== "null") : t) ?? "string";
};

/**
 * Reads `@path` as the file's text and `-` as standard input; anything else is the value itself. Used only for JSON
 * values (--args and object arguments), never for text, so `clonvo web_search "@openai"` searches for "@openai".
 */
export type ValueReader = (raw: string) => Promise<string>;

export const defaultReader: ValueReader = async (raw) => {
  if (raw === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  if (raw.startsWith("@") && raw.length > 1) return readFile(raw.slice(1), "utf8");
  return raw;
};

function parseJson(name: string, text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ClonvoError(`--${name} needs JSON. Pass it inline, as @file.json, or - to read standard input.`);
  }
}

/** One command-line value, converted to the property's type. */
async function convert(name: string, schema: JsonSchema | undefined, raw: string, read: ValueReader): Promise<unknown> {
  const type = typeOf(schema);
  if (type === "integer" || type === "number") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) throw new ClonvoError(`--${name} needs ${type === "integer" ? "a whole number" : "a number"}, not "${raw}".`);
    return n;
  }
  if (type === "boolean") {
    if (/^(true|yes|1)$/i.test(raw)) return true;
    if (/^(false|no|0)$/i.test(raw)) return false;
    throw new ClonvoError(`--${name} is true or false, not "${raw}".`);
  }
  if (type === "object") return parseJson(name, await read(raw));
  if (type === "array") {
    if (raw.trim().startsWith("[")) return parseJson(name, raw);
    return [await convert(name, schema?.items, raw, read)];
  }
  return raw;
}

const propertyName = (schema: JsonSchema, flag: string) => {
  const props = schema.properties ?? {};
  const snake = flag.replace(/-/g, "_");
  return Object.hasOwn(props, snake) ? snake : Object.hasOwn(props, flag) ? flag : null;
};

/**
 * Turns `clonvo web_search "query" --limit 5 --include-domains a.com --include-domains b.com` into the call's
 * arguments. Words without a flag fill the required properties in order. `--args '{…}'` (or @file, or -) supplies
 * a whole JSON object; flags given alongside it win.
 */
export async function argumentsFor(tool: Tool, words: string[], read: ValueReader = defaultReader): Promise<Record<string, unknown>> {
  const schema = tool.input_schema;
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  const positional: string[] = [];
  let base: Record<string, unknown> = {};

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") {
      positional.push(...words.slice(i + 1));
      break;
    }
    if (!word.startsWith("--") || word.length === 2) {
      positional.push(word);
      continue;
    }
    let flag = word.slice(2);
    let value: string | undefined;
    const eq = flag.indexOf("=");
    if (eq >= 0) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    if (flag === "args") {
      const raw = value ?? words[++i];
      if (raw === undefined) throw new ClonvoError("--args needs a JSON object.");
      const parsed = parseJson("args", await read(raw));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ClonvoError("--args needs a JSON object, like '{\"query\": \"…\"}'.");
      base = parsed as Record<string, unknown>;
      continue;
    }
    let name = propertyName(schema, flag);
    let negated = false;
    if (!name && flag.startsWith("no-")) {
      name = propertyName(schema, flag.slice(3));
      negated = name !== null && typeOf(props[name]) === "boolean";
      if (!negated) name = null;
    }
    if (!name) throw new ClonvoError(`${tool.id} has no option --${flag}. Run \`clonvo ${tool.id} --help\` to see its options.`);
    const prop = props[name];
    if (typeOf(prop) === "boolean" && value === undefined) {
      const next = words[i + 1];
      if (!negated && next !== undefined && /^(true|false|yes|no|1|0)$/i.test(next)) value = words[++i];
      else {
        out[name] = !negated;
        continue;
      }
    }
    if (value === undefined) {
      value = words[++i];
      if (value === undefined) throw new ClonvoError(`--${flag} needs a value.`);
    }
    const converted = await convert(flag, prop, value, read);
    if (typeOf(prop) === "array" && Array.isArray(out[name]) && !value.trim().startsWith("[")) out[name] = [...(out[name] as unknown[]), ...(converted as unknown[])];
    else out[name] = converted;
  }

  const required = (schema.required ?? []).filter((name) => !(name in out) && !(name in base));
  if (positional.length > required.length) {
    const extra = positional.slice(required.length).join(" ");
    throw new ClonvoError(
      required.length
        ? `Too many values: "${extra}". ${tool.id} takes ${required.map((r) => `<${r}>`).join(" ")}; put quotes around a value with spaces.`
        : `Unexpected "${extra}". Pass ${tool.id}'s options as flags; see \`clonvo ${tool.id} --help\`.`,
    );
  }
  for (const [index, raw] of positional.entries()) {
    const name = required[index]!;
    out[name] = await convert(name, props[name], raw, read);
  }
  const args = { ...base, ...out };
  const missing = (schema.required ?? []).filter((name) => !(name in args));
  if (missing.length) throw new ClonvoError(`${tool.id} needs ${missing.map((m) => `--${m.replace(/_/g, "-")}`).join(" and ")}. Run \`clonvo ${tool.id} --help\` for details.`);
  return args;
}

const isJob = (value: unknown): value is ToolJob => !!value && typeof value === "object" && (value as { object?: string }).object === "tool.job";

export interface CallOptions {
  wait: boolean;
  provider?: string;
  onProgress?: (job: ToolJob) => void;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    });
  });

/** Calls the tool. A long-running tool's job is followed until it ends, unless `wait` is off. */
export async function callTool(client: Client, toolId: string, args: Record<string, unknown>, options: CallOptions): Promise<ToolCall | ToolJob> {
  const body = { arguments: args, ...(options.provider ? { provider: { only: options.provider.split(",").map((p) => p.trim()).filter(Boolean) } } : {}) };
  const { data } = await client.request<ToolCall | ToolJob>("POST", `/v1/tools/${encodeURIComponent(toolId)}`, body, { signal: options.signal });
  if (!isJob(data) || data.status !== "running" || !options.wait) return data;
  let job = data;
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms, options.signal));
  while (job.status === "running") {
    options.onProgress?.(job);
    await sleep(Math.min(Math.max(job.poll_after_ms ?? 2_000, 500), 10_000));
    job = (await client.request<ToolJob>("GET", `/v1/tools/jobs/${encodeURIComponent(job.id)}`, undefined, { signal: options.signal })).data;
  }
  return job;
}

export const cancelJob = (client: Client, id: string) => client.request<ToolJob>("DELETE", `/v1/tools/jobs/${encodeURIComponent(id)}`).then((r) => r.data);
export const getJob = (client: Client, id: string) => client.request<ToolJob>("GET", `/v1/tools/jobs/${encodeURIComponent(id)}`).then((r) => r.data);

/** Wraps text to `width` columns, indenting every line by `indent`. */
function wrap(text: string, width: number, indent: string) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(indent + line);
  return lines.join("\n");
}

/** Help for one tool, built from its schema. */
export function toolHelp(tool: Tool, width = Math.min(process.stdout.columns || 100, 100)) {
  const props = tool.input_schema.properties ?? {};
  const required = tool.input_schema.required ?? [];
  const usage = [`clonvo ${tool.id}`, ...required.map((r) => `<${r}>`), Object.keys(props).length > required.length ? "[options]" : ""].filter(Boolean).join(" ");
  const lines = [wrap(tool.description, width, ""), "", `Usage: ${usage}`, "", "Options:"];
  const option = (flag: string, notes: string) => lines.push(`  ${flag}`, wrap(notes, width, "      "));
  for (const [name, schema] of Object.entries(props)) {
    const type = typeOf(schema);
    const hint = schema.enum ? "value" : type === "boolean" ? "" : type === "array" ? `${typeOf(schema.items)}…` : type === "object" ? "json" : type;
    const notes = [schema.description ?? "", schema.enum ? `One of: ${schema.enum.join(", ")}.` : "", required.includes(name) ? "Required." : ""].filter(Boolean).join(" ");
    option(`--${name.replace(/_/g, "-")}${hint ? ` <${hint}>` : ""}`, notes);
  }
  option("--args <json>", "All arguments as one JSON object: inline, @file.json, or - for standard input. Flags given alongside it win.");
  lines.push("", wrap("A json option also takes @file.json, or - to read standard input. Repeat a list option to add items, or pass a JSON array.", width, ""));
  lines.push(`Providers: ${tool.providers.join(", ") || "none"}${tool.available_providers.length ? ` (available to you: ${tool.available_providers.join(", ")})` : " (none available to you yet)"}`);
  return lines.join("\n");
}
