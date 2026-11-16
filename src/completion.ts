// Shell completion: `clonvo completion bash|zsh|fish` prints a script, and the script asks the hidden
// `clonvo __complete <words…>` for candidates. Tool names and flags come from a cache of the last `GET /v1/tools`,
// so pressing Tab never waits on the network.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config.js";
import type { Tool } from "./tools.js";

export const COMMANDS = ["login", "logout", "whoami", "balance", "tools", "jobs", "completion", "help", "version"] as const;

const COMMAND_FLAGS: Record<string, string[]> = {
  login: ["--with-key", "--no-browser"],
  whoami: ["--json"],
  balance: ["--json"],
  tools: ["--json"],
  jobs: ["get", "cancel"],
  completion: ["bash", "zsh", "fish"],
};

/** Flags every tool call takes, besides its own arguments. */
export const TOOL_CALL_FLAGS = ["--full", "--compact", "--no-wait", "--provider", "--args", "--help"];

interface CachedTool {
  id: string;
  flags: string[];
}

const cachePath = (env: NodeJS.ProcessEnv) => join(configDir(env), "tools-cache.json");

/** Saves tool ids and their flags (no descriptions, nothing private) for completion. Never throws. */
export async function cacheTools(tools: Tool[], env: NodeJS.ProcessEnv = process.env) {
  const entries: CachedTool[] = tools.map((t) => ({ id: t.id, flags: Object.keys(t.input_schema.properties ?? {}).map((p) => `--${p.replace(/_/g, "-")}`) }));
  try {
    await mkdir(configDir(env), { recursive: true, mode: 0o700 });
    await writeFile(cachePath(env), JSON.stringify(entries));
  } catch {
    // Completion just won't know the tools yet.
  }
}

async function cachedTools(env: NodeJS.ProcessEnv): Promise<CachedTool[]> {
  try {
    const value = JSON.parse(await readFile(cachePath(env), "utf8")) as CachedTool[];
    return Array.isArray(value) ? value.filter((t) => typeof t?.id === "string" && Array.isArray(t.flags)) : [];
  } catch {
    return [];
  }
}

/** Candidates for the next word, given the words typed after `clonvo`. The shell filters them by prefix. */
export async function complete(words: string[], env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const tools = await cachedTools(env);
  const [first] = words;
  if (first === undefined) return [...COMMANDS, ...tools.map((t) => t.id)];
  if (first === "help") return words.length === 1 ? [...COMMANDS, ...tools.map((t) => t.id)] : [];
  if (Object.hasOwn(COMMAND_FLAGS, first)) {
    const options = COMMAND_FLAGS[first]!;
    // jobs and completion take one word.
    if ((first === "jobs" || first === "completion") && words.length > 1) return [];
    return options.filter((o) => !words.includes(o));
  }
  const tool = tools.find((t) => t.id === first.toLowerCase().replace(/-/g, "_"));
  if (!tool) return [];
  return [...tool.flags, ...TOOL_CALL_FLAGS];
}

export function completionScript(shell: string) {
  switch (shell) {
    case "bash":
      return `# clonvo completion for bash. Add to ~/.bashrc:  eval "$(clonvo completion bash)"
_clonvo() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local IFS=$'\\n'
  COMPREPLY=( $(compgen -W "$(clonvo __complete "\${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null)" -- "$cur") )
}
complete -o default -F _clonvo clonvo`;
    case "zsh":
      return `# clonvo completion for zsh. Add to ~/.zshrc, after compinit:  eval "$(clonvo completion zsh)"
_clonvo() {
  local -a candidates
  candidates=("\${(@f)$(clonvo __complete "\${(@)words[2,CURRENT-1]}" 2>/dev/null)}")
  compadd -a candidates
}
compdef _clonvo clonvo`;
    case "fish":
      return `# clonvo completion for fish. Save as ~/.config/fish/completions/clonvo.fish:  clonvo completion fish > ~/.config/fish/completions/clonvo.fish
complete -c clonvo -f -a '(clonvo __complete (commandline -opc)[2..-1] 2>/dev/null)'`;
    default:
      return null;
  }
}
