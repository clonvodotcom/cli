import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheTools, complete, completionScript } from "../src/completion.js";
import { colorEnabled } from "../src/term.js";
import type { Tool } from "../src/tools.js";
import { isNewer, notifierEnabled, startUpdateCheck } from "../src/update.js";

const tool: Tool = {
  id: "web_search",
  name: "Web search",
  description: "Search.",
  providers: [],
  available_providers: [],
  input_schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, max_results: { type: "integer" } } },
};

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("completion", () => {
  it("offers commands and cached tools, then a tool's flags, without the network", async () => {
    const env = { CLONVO_CONFIG_DIR: await mkdtemp(join(tmpdir(), "clonvo-comp-")) };
    expect(await complete([], env)).toContain("login");
    await cacheTools([tool], env);
    expect(await complete([], env)).toEqual(expect.arrayContaining(["login", "web_search"]));
    expect(await complete(["web-search"], env)).toEqual(expect.arrayContaining(["--query", "--max-results", "--no-wait"]));
    expect(await complete(["jobs"], env)).toEqual(["get", "cancel"]);
    expect(await complete(["login", "--with-key"], env)).toEqual(["--no-browser"]);
    expect(JSON.parse(await readFile(join(env.CLONVO_CONFIG_DIR, "tools-cache.json"), "utf8"))).toEqual([{ id: "web_search", flags: ["--query", "--max-results"] }]);
  });

  it("prints scripts for bash, zsh and fish only", () => {
    expect(completionScript("bash")).toContain("complete -o default -F _clonvo clonvo");
    expect(completionScript("zsh")).toContain("compdef _clonvo clonvo");
    expect(completionScript("fish")).toContain("complete -c clonvo");
    expect(completionScript("tcsh")).toBeNull();
  });
});

describe("update notice", () => {
  it("compares versions", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("1.0.0-beta.1", "0.9.0")).toBe(false);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  });

  it("stays quiet in CI, off a terminal, and when turned off", () => {
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    expect(notifierEnabled({}, { isTTY: true })).toBe(true);
    expect(notifierEnabled({}, { isTTY: false })).toBe(false);
    expect(notifierEnabled({ CLONVO_NO_UPDATE_NOTIFIER: "1" }, { isTTY: true })).toBe(false);
    process.env.CI = "true";
    expect(notifierEnabled({}, { isTTY: true })).toBe(false);
  });

  it("checks at most once a day and shows what the last check found", async () => {
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    const isTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    try {
      const env = { CLONVO_CONFIG_DIR: await mkdtemp(join(tmpdir(), "clonvo-upd-")) };
      let calls = 0;
      const fetchImpl: typeof fetch = async () => (calls++, new Response(JSON.stringify({ version: "9.9.9" })));
      const first = await startUpdateCheck(env, fetchImpl, () => 1_000);
      expect(first.notice).toBeNull();
      await first.finish();
      const second = await startUpdateCheck(env, fetchImpl, () => 2_000);
      expect(second.notice).toContain("→ 9.9.9");
      expect(calls).toBe(1);
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });
    }
  });
});

describe("color", () => {
  it("follows NO_COLOR, FORCE_COLOR, TERM=dumb and --no-color", () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    delete process.env.CLONVO_NO_COLOR_FLAG;
    process.env.TERM = "xterm-256color";
    expect(colorEnabled({ isTTY: true })).toBe(true);
    expect(colorEnabled({ isTTY: false })).toBe(false);
    process.env.FORCE_COLOR = "1";
    expect(colorEnabled({ isTTY: false })).toBe(true);
    process.env.FORCE_COLOR = "0";
    expect(colorEnabled({ isTTY: true })).toBe(false);
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = "1";
    expect(colorEnabled({ isTTY: true })).toBe(false);
    delete process.env.NO_COLOR;
    process.env.TERM = "dumb";
    expect(colorEnabled({ isTTY: true })).toBe(false);
    process.env.TERM = "xterm";
    process.env.CLONVO_NO_COLOR_FLAG = "1";
    expect(colorEnabled({ isTTY: true })).toBe(false);
  });
});
