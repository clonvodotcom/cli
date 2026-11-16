import { describe, expect, it } from "vitest";
import { argumentsFor, callTool, findTool, similarTools, toolHelp, type Tool, type ToolJob } from "../src/tools.js";
import type { Client } from "../src/api.js";

const search: Tool = {
  id: "web_search",
  name: "Web search",
  description: "Search the web. Returns ranked results.",
  providers: ["clonvo", "exa"],
  available_providers: ["clonvo"],
  input_schema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "What to search for." },
      max_results: { type: "integer" },
      include_content: { type: "boolean" },
      include_domains: { type: "array", items: { type: "string" } },
      time_range: { type: "string", enum: ["day", "week"] },
    },
  },
};

const extract: Tool = {
  ...search,
  id: "web_extract",
  input_schema: { type: "object", required: ["url", "schema"], properties: { url: { type: "string" }, schema: { type: "object" } } },
};

const files: Record<string, string> = { "schema.json": '{"type":"object"}', "-": '{"query":"from stdin"}' };
const read = async (raw: string) => (raw === "-" ? files["-"]! : raw.startsWith("@") ? files[raw.slice(1)]! : raw);

describe("argumentsFor", () => {
  it("fills required properties from bare words and types flags by the schema", async () => {
    expect(await argumentsFor(search, ["agent frameworks", "--max-results", "5", "--include-content", "--time_range=week"], read)).toEqual({
      query: "agent frameworks",
      max_results: 5,
      include_content: true,
      time_range: "week",
    });
  });

  it("collects repeated array flags, and takes a JSON array as is", async () => {
    expect(await argumentsFor(search, ["q", "--include-domains", "a.com", "--include-domains", "b.com"], read)).toMatchObject({ include_domains: ["a.com", "b.com"] });
    expect(await argumentsFor(search, ["q", "--include-domains", '["c.com"]'], read)).toMatchObject({ include_domains: ["c.com"] });
  });

  it("reads --no-<flag>, and an explicit boolean value", async () => {
    expect(await argumentsFor(search, ["q", "--no-include-content"], read)).toMatchObject({ include_content: false });
    expect(await argumentsFor(search, ["q", "--include-content", "false"], read)).toMatchObject({ include_content: false });
  });

  it("reads JSON values from @file, and the whole call from --args -", async () => {
    expect(await argumentsFor(extract, ["https://example.com", "--schema", "@schema.json"], read)).toEqual({ url: "https://example.com", schema: { type: "object" } });
    expect(await argumentsFor(search, ["--args", "-", "--max-results", "3"], read)).toEqual({ query: "from stdin", max_results: 3 });
  });

  it("explains bad input in terms of the tool's options", async () => {
    await expect(argumentsFor(search, [], read)).rejects.toThrow("web_search needs --query");
    await expect(argumentsFor(search, ["q", "--colour", "red"], read)).rejects.toThrow("web_search has no option --colour");
    await expect(argumentsFor(search, ["q", "--max-results", "lots"], read)).rejects.toThrow("--max-results needs a whole number");
    await expect(argumentsFor(search, ["two", "words"], read)).rejects.toThrow('Too many values: "words"');
  });

  it("never reads a file or standard input for text, only for JSON options", async () => {
    let reads = 0;
    const spy = async (raw: string) => (reads++, read(raw));
    expect(await argumentsFor(search, ["@schema.json", "--include-domains", "@schema.json"], spy)).toEqual({ query: "@schema.json", include_domains: ["@schema.json"] });
    expect(await argumentsFor(search, ["-"], spy)).toEqual({ query: "-" });
    expect(reads).toBe(0);
  });

  it("treats everything after -- as values", async () => {
    expect(await argumentsFor(search, ["--", "--not-a-flag"], read)).toEqual({ query: "--not-a-flag" });
  });
});

describe("tools", () => {
  it("finds a tool by any spelling", () => {
    expect(findTool([search], "web-search")?.id).toBe("web_search");
    expect(findTool([search], "WEB_SEARCH")?.id).toBe("web_search");
    expect(findTool([search], "nope")).toBeNull();
  });

  it("suggests close names for a typo", () => {
    expect(similarTools([search, extract], "serch")).toEqual(["web_search"]);
    expect(similarTools([search, extract], "web_extrct")).toEqual(["web_extract"]);
    expect(similarTools([search, extract], "deploy")).toEqual([]);
  });

  it("builds help from the schema", () => {
    const help = toolHelp(search);
    expect(help).toContain("Usage: clonvo web_search <query> [options]");
    expect(help).toContain("--max-results <integer>");
    expect(help).toContain("--time-range <value>");
    expect(help).toContain("One of: day, week.");
  });
});

describe("callTool", () => {
  const job = (status: ToolJob["status"], extra: Partial<ToolJob> = {}): ToolJob => ({ id: "gen-1", object: "tool.job", tool: "web_research", status, provider: "clonvo", poll_after_ms: 1000, ...extra });

  it("follows a running job until it finishes", async () => {
    const calls: string[] = [];
    const replies = [job("running"), job("running"), job("completed", { result: { report: "done" } })];
    const client: Client = { baseUrl: "x", mode: "oauth", request: async (method, path) => (calls.push(`${method} ${path}`), { status: 200, data: replies.shift() as never, headers: new Headers() }) };
    const result = await callTool(client, "web_research", { query: "q" }, { wait: true, sleep: async () => {} });
    expect(result).toMatchObject({ status: "completed", result: { report: "done" } });
    expect(calls).toEqual(["POST /v1/tools/web_research", "GET /v1/tools/jobs/gen-1", "GET /v1/tools/jobs/gen-1"]);
  });

  it("returns the job at once with --no-wait, and limits providers with --provider", async () => {
    let body: unknown;
    const client: Client = { baseUrl: "x", mode: "key", request: async (_m, _p, b) => ((body = b), { status: 202, data: job("running") as never, headers: new Headers() }) };
    expect(await callTool(client, "web_research", { query: "q" }, { wait: false, provider: "clonvo, exa" })).toMatchObject({ status: "running" });
    expect(body).toEqual({ arguments: { query: "q" }, provider: { only: ["clonvo", "exa"] } });
  });
});
