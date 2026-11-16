#!/usr/bin/env node
// The `clonvo` command.
import { createInterface } from "node:readline";
import { ClonvoError, createClient, errorFrom, userAgent, type Client } from "./api.js";
import { cacheTools, complete, completionScript, COMMANDS } from "./completion.js";
import { clean, safeJson } from "./errors.js";
import { apiUrl, credentialsPath, writeCredentials } from "./config.js";
import { browserLogin, revokeSaved } from "./login.js";
import { dim, red, yellow } from "./term.js";
import { argumentsFor, callTool, cancelJob, distance, findTool, getJob, listTools, similarTools, toolHelp, type ToolCall, type ToolJob } from "./tools.js";
import { startUpdateCheck } from "./update.js";
import { VERSION } from "./version.js";

const HELP = `Clonvo CLI ${VERSION}: call Clonvo's tools from your terminal.

Usage:
  clonvo <command> [flags]
  clonvo <tool> [args] [flags]

Commands:
  login                Sign in with your browser and pick the project calls bill to
  logout               Sign out and disconnect this computer
  whoami               Show how you're signed in, your plan and balance
  balance              Print your credit balance
  tools                List the tools you can call
  jobs get|cancel <id> Read or cancel a long-running job
  completion <shell>   Print shell completion for bash, zsh or fish
  help [command|tool]  Show help for a command or a tool

Tool calls:
  clonvo <tool> --help Show a tool's arguments
  --full               Print the whole response (id, provider, usage), not just the result
  --compact            Print JSON on one line
  --no-wait            Return a long-running job at once instead of waiting for it
  --provider <ids>     Only use these providers (comma-separated), e.g. clonvo

Global flags:
  --debug              Log each HTTP request to stderr (never tokens or bodies)
  --no-color           Turn off color
  -h, --help           Show help
  -v, --version        Show the version

Examples:
  $ clonvo login
  $ clonvo web_search "durable objects vs queues" --max-results 3
  $ clonvo web_scrape https://example.com --compact | jq -r .markdown
  $ clonvo web_research "state of browser agents" --no-wait
  $ CLONVO_API_KEY=sk-cv-v1-… clonvo whoami --json

Environment:
  CLONVO_API_KEY             Use this API key instead of the saved sign-in
  CLONVO_API_URL             API to talk to (default https://api.clonvo.com)
  CLONVO_CONFIG_DIR          Where to keep the sign-in (default ~/.config/clonvo)
  CLONVO_DEBUG=1             Same as --debug
  CLONVO_NO_UPDATE_NOTIFIER  Don't check npm for a newer version
  NO_COLOR / FORCE_COLOR     Turn color off or on

Exit codes: 0 ok, 1 failed, 4 sign in first, 130 cancelled.
The CLI collects no telemetry. Docs: https://clonvo.com/docs/cli`;

const COMMAND_HELP: Record<string, string> = {
  login: `Usage: clonvo login [--no-browser] [--with-key]

Signs in with your browser: Clonvo opens, you pick the organization and project calls bill to, and the CLI saves
the sign-in. Each sign-in is its own connection, listed under Settings → Connected apps.

  --no-browser   Print the sign-in link instead of opening it
  --with-key     Save an API key instead, read from standard input (or typed, hidden)

Examples:
  $ clonvo login
  $ echo "$CLONVO_KEY" | clonvo login --with-key`,
  logout: "Usage: clonvo logout\n\nSigns out and ends this computer's connection on Clonvo's side.",
  whoami: "Usage: clonvo whoami [--json]\n\nShows how you're signed in, the API, the key, project, plan and balance.",
  balance: "Usage: clonvo balance [--json]\n\nPrints the organization's credit balance.",
  tools: "Usage: clonvo tools [--json]\n\nLists the tools you can call. --json prints each tool with its argument schema.",
  jobs: "Usage: clonvo jobs get <id> [--compact]\n       clonvo jobs cancel <id>\n\nReads or cancels a long-running tool call (web_crawl, web_research, browser_task).",
  completion: `Usage: clonvo completion bash|zsh|fish

Prints a completion script. Install it with:
  bash  echo 'eval "$(clonvo completion bash)"' >> ~/.bashrc
  zsh   echo 'eval "$(clonvo completion zsh)"' >> ~/.zshrc
  fish  clonvo completion fish > ~/.config/fish/completions/clonvo.fish`,
};

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line = "") => process.stderr.write(`${line}\n`);

/** Exit codes, as gh uses them: 4 means sign in first, so scripts can tell it apart from a failed call. */
const EXIT = { failed: 1, signIn: 4, cancelled: 130 } as const;

const usd = (n: number) => `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;

/** The description's first sentence; "e.g." and "i.e." don't end one. */
export function firstSentence(text: string) {
  const end = /(?<!\b(?:e\.g|i\.e|etc))[.!?](?=\s|$)/.exec(text);
  return end ? text.slice(0, end.index + 1) : text;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`);

function printJson(value: unknown, compact: boolean) {
  out(safeJson(value, compact));
}

/** Takes the CLI's own flags out of a tool call's words. */
function takeFlags(words: string[]) {
  const flags = { full: false, compact: false, wait: true, help: false, provider: undefined as string | undefined };
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") {
      rest.push(...words.slice(i));
      break;
    }
    if (w === "--full") flags.full = true;
    else if (w === "--compact") flags.compact = true;
    else if (w === "--no-wait") flags.wait = false;
    else if (w === "--help" || w === "-h") flags.help = true;
    else if (w === "--provider") flags.provider = words[++i];
    else if (w.startsWith("--provider=")) flags.provider = w.slice("--provider=".length);
    else rest.push(w);
  }
  return { flags, rest };
}

async function readSecretLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // Hide what's typed: echo nothing after the prompt.
  const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    if (s.includes(prompt)) write.call(rl, s);
  };
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  process.stderr.write("\n");
  return answer.trim();
}

async function login(args: string[]) {
  const base = apiUrl();
  if (args.includes("--with-key")) {
    const key = await readSecretLine("Paste your Clonvo API key: ");
    if (!key) throw new ClonvoError("No key given. Create one at https://clonvo.com/app and run `clonvo login --with-key` again.");
    const res = await fetch(`${base}/v1/key`, { headers: { authorization: `Bearer ${key}`, "user-agent": userAgent() }, redirect: "error" });
    if (!res.ok) throw await errorFrom(res);
    await revokeSaved();
    await writeCredentials({ type: "key", apiUrl: base, apiKey: key });
    err(`Saved. Calls use this API key. Your credentials are in ${credentialsPath()}.`);
    return;
  }
  await browserLogin(base, { openBrowser: !args.includes("--no-browser"), log: err });
  const client = await createClient();
  const { data } = await client.request<{ data: { label: string; plan: string } }>("GET", "/v1/key");
  err(`Signed in. Calls bill to the project you picked, on the ${clean(String(data.data.plan))} plan.`);
  err(dim("Try: clonvo web_search \"what's new in agent frameworks\""));
}

async function logout() {
  const saved = await revokeSaved();
  err(saved ? "Signed out. This computer is disconnected from Clonvo." : "You weren't signed in.");
  if (process.env.CLONVO_API_KEY) err(dim("CLONVO_API_KEY is still set in your environment, so calls keep using that key."));
}

async function balanceOf(client: Client) {
  const { data } = await client.request<{ data: { total_credits: number; total_usage: number } }>("GET", "/v1/credits");
  return data.data.total_credits - data.data.total_usage;
}

async function whoami(args: string[]) {
  const client = await createClient();
  const [{ data: key }, balance] = await Promise.all([
    client.request<{ data: { label: string; plan: string; project_id: string; limit: number | null; limit_remaining: number | null } }>("GET", "/v1/key"),
    balanceOf(client),
  ]);
  const info = {
    signed_in_with: process.env.CLONVO_API_KEY ? "CLONVO_API_KEY" : client.mode === "oauth" ? "browser sign-in" : "saved API key",
    api: client.baseUrl,
    key: key.data.label,
    project_id: key.data.project_id,
    plan: key.data.plan,
    balance: Math.round(balance * 100) / 100,
    key_limit_remaining: key.data.limit_remaining,
  };
  if (args.includes("--json")) return printJson(info, false);
  const rows: Array<[string, string]> = [
    ["Signed in with", info.signed_in_with],
    ["API", info.api],
    ["Key", info.key],
    ["Project", info.project_id],
    ["Plan", info.plan],
    ["Balance", usd(balance)],
  ];
  if (info.key_limit_remaining !== null) rows.push(["Key limit left", usd(info.key_limit_remaining)]);
  for (const [k, v] of rows) out(`${k.padEnd(15)} ${clean(String(v))}`);
}

async function balance(args: string[]) {
  const value = await balanceOf(await createClient());
  if (args.includes("--json")) return printJson({ balance: Math.round(value * 100) / 100 }, true);
  out(usd(value));
}

async function tools(args: string[]) {
  const list = await listTools(await createClient());
  await cacheTools(list);
  if (args.includes("--json")) return printJson(list, false);
  const width = Math.max(...list.map((t) => t.id.length));
  const columns = process.stdout.isTTY ? process.stdout.columns || 100 : Infinity;
  for (const t of list) {
    const usable = t.available_providers.length > 0;
    const text = `${clean(firstSentence(t.description))}${usable ? "" : " (not available on your plan or keys yet)"}`;
    const fitted = clip(text, columns - width - 2);
    out(`${clean(t.id).padEnd(width)}  ${usable ? fitted : dim(fitted)}`);
  }
  err(dim(`\nRun \`clonvo <tool> --help\` for a tool's options.`));
}

async function jobs(args: string[]) {
  const [action, id] = args;
  if ((action !== "get" && action !== "cancel") || !id) throw new ClonvoError("Usage: clonvo jobs get <id>  or  clonvo jobs cancel <id>");
  const client = await createClient();
  printJson(action === "get" ? await getJob(client, id) : await cancelJob(client, id), args.includes("--compact"));
}

function summary(response: ToolCall | ToolJob) {
  const parts = [clean(response.tool), clean(response.provider ?? ""), response.usage ? usd(response.usage.charged) : "", (response as ToolCall).cached ? "cached" : "", response.id];
  return dim(parts.filter(Boolean).join(" · "));
}

async function runTool(name: string, words: string[]) {
  const { flags, rest } = takeFlags(words);
  const client = await createClient();
  const list = await listTools(client);
  await cacheTools(list);
  const tool = findTool(list, name);
  if (!tool) {
    const close = [...similarCommands(name), ...similarTools(list, name)];
    throw new ClonvoError(`Unknown command or tool "${name}".${close.length ? ` Did you mean ${close.slice(0, 3).join(", ")}?` : ""} Run \`clonvo --help\` for commands, or \`clonvo tools\` for tools.`);
  }
  if (flags.help) return out(clean(toolHelp(tool)));
  const args = await argumentsFor(tool, rest);

  const controller = new AbortController();
  let jobId: string | null = null;
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    controller.abort();
  };
  process.once("SIGINT", onSigint);
  const started = Date.now();
  try {
    const response = await callTool(client, tool.id, args, {
      wait: flags.wait,
      provider: flags.provider,
      signal: controller.signal,
      onProgress: (job) => {
        jobId = job.id;
        if (process.stderr.isTTY) process.stderr.write(`\r${dim(`${job.tool} is running… ${Math.round((Date.now() - started) / 1000)}s (Ctrl-C cancels)`)}`);
      },
    });
    if (jobId && process.stderr.isTTY) process.stderr.write("\r\x1b[K");
    if ("object" in response && response.object === "tool.job") {
      if (response.status === "running") {
        printJson(response, flags.compact);
        err(dim(`Still running. Check it with: clonvo jobs get ${response.id}`));
        return;
      }
      if (response.status !== "completed") {
        if (flags.full) printJson(response, flags.compact);
        throw new ClonvoError(clean(response.error?.message ?? `The job ${response.status}.`), 0, response.error?.code ?? null);
      }
    }
    printJson(flags.full ? response : response.result, flags.compact);
    if (process.stderr.isTTY) err(summary(response));
  } catch (error) {
    if (interrupted) {
      if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
      if (jobId) {
        await cancelJob(client, jobId).catch(() => {});
        err(`Cancelled job ${jobId}.`);
      }
      process.exitCode = EXIT.cancelled;
      return;
    }
    throw error;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

const similarCommands = (name: string) => COMMANDS.filter((c) => distance(name.toLowerCase(), c) <= 2);

async function help(topic: string | undefined) {
  if (!topic) return out(HELP);
  if (Object.hasOwn(COMMAND_HELP, topic)) return out(COMMAND_HELP[topic]);
  // A tool: its help comes from its schema.
  return runTool(topic, ["--help"]);
}

/** Takes --debug and --no-color out of the words, wherever they are (up to a bare --). */
function globalFlags(argv: string[]) {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (w === "--debug") process.env.CLONVO_DEBUG = "1";
    else if (w === "--no-color") process.env.CLONVO_NO_COLOR_FLAG = "1";
    else rest.push(w);
  }
  return rest;
}

export async function main(argv: string[]) {
  const [command, ...rest] = globalFlags(argv);
  // Completion runs on every Tab press: nothing slow, nothing printed but candidates.
  if (command === "__complete") return out((await complete(rest)).join("\n"));
  if (command === "completion") {
    const script = rest[0] ? completionScript(rest[0]) : null;
    if (!script) throw new ClonvoError("Usage: clonvo completion bash|zsh|fish");
    return out(script);
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    if (command && Object.hasOwn(COMMAND_HELP, command)) return out(COMMAND_HELP[command]);
  }
  const update = await startUpdateCheck().catch(() => ({ notice: null, finish: async () => {} }));
  try {
    await dispatch(command, rest);
  } finally {
    await update.finish();
    if (update.notice) err(yellow(update.notice));
  }
}

async function dispatch(command: string | undefined, rest: string[]) {
  switch (command) {
    case undefined:
    case "--help":
    case "-h":
      return out(HELP);
    case "help":
      return help(rest[0]);
    case "--version":
    case "-v":
    case "version":
      return out(`clonvo ${VERSION}`);
    case "login":
      return login(rest);
    case "logout":
      return logout();
    case "whoami":
    case "status":
      return whoami(rest);
    case "balance":
      return balance(rest);
    case "tools":
      return tools(rest);
    case "jobs":
    case "job":
      return jobs(rest);
    default:
      if (command.startsWith("-")) throw new ClonvoError(`Unknown flag ${command}. Run \`clonvo --help\`.`);
      // A mistyped command (loign, toools) is caught before any sign-in or network call. Tool ids have an
      // underscore and are never this close to a command.
      if (!command.includes("_") && !command.includes("-")) {
        const close = similarCommands(command);
        if (close.length) throw new ClonvoError(`Unknown command "${command}". Did you mean ${close.join(", ")}? Run \`clonvo --help\` for commands.`);
      }
      return runTool(command, rest);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof ClonvoError) err(red(`error: ${clean(error.message)}`));
  else if (error instanceof Error && /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(`${error.message} ${(error as { cause?: Error }).cause?.message ?? ""}`)) err(red("error: Couldn't reach Clonvo. Check your connection and try again."));
  else err(red(`error: ${clean(error instanceof Error ? error.message : String(error))}`));
  process.exitCode = error instanceof ClonvoError && error.code === "signed_out" ? EXIT.signIn : EXIT.failed;
});
