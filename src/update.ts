// "A new version is available": checked against the npm registry at most once a day, in the background, and shown
// on the next run. Never in CI, never when stderr isn't a terminal, and off with CLONVO_NO_UPDATE_NOTIFIER=1.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config.js";
import { inCI } from "./term.js";
import { VERSION } from "./version.js";

const DAY_MS = 86_400_000;
const REGISTRY_URL = "https://registry.npmjs.org/@clonvo%2Fcli/latest";

interface State {
  checkedAt: number;
  latest: string | null;
}

const statePath = (env: NodeJS.ProcessEnv) => join(configDir(env), "update-check.json");

/** True when `a` is a newer release than `b` (x.y.z; pre-releases never count as newer). */
export function isNewer(a: string, b: string) {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number) ?? null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

export function notifierEnabled(env: NodeJS.ProcessEnv = process.env, stderr: { isTTY?: boolean } = process.stderr) {
  const off = env.CLONVO_NO_UPDATE_NOTIFIER;
  return !!stderr.isTTY && !inCI() && !(off && off !== "0" && off !== "false");
}

async function readState(env: NodeJS.ProcessEnv): Promise<State | null> {
  try {
    const s = JSON.parse(await readFile(statePath(env), "utf8")) as State;
    return typeof s.checkedAt === "number" ? s : null;
  } catch {
    return null;
  }
}

/**
 * Starts the check if the last one is more than a day old, and returns the notice to print from the last check (or
 * null). The check never delays the command: `finish` waits at most a moment for it, and a slow registry is skipped.
 */
export async function startUpdateCheck(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, now = Date.now) {
  if (!notifierEnabled(env)) return { notice: null as string | null, finish: async () => {} };
  const state = await readState(env);
  const notice = state?.latest && isNewer(state.latest, VERSION) ? `A new version of clonvo is available: ${VERSION} → ${state.latest}. Update with: npm install -g @clonvo/cli@latest` : null;
  if (state && now() - state.checkedAt < DAY_MS) return { notice, finish: async () => {} };
  // Record the attempt first, so a registry too slow to answer is asked again tomorrow rather than on every run.
  const save = async (latest: string | null) => {
    await mkdir(configDir(env), { recursive: true, mode: 0o700 });
    await writeFile(statePath(env), JSON.stringify({ checkedAt: now(), latest } satisfies State));
  };
  await save(state?.latest ?? null).catch(() => {});
  // Aborted when the command is done, so a slow registry never keeps the process running.
  const controller = new AbortController();
  const check = fetchImpl(REGISTRY_URL, { headers: { accept: "application/json" }, signal: controller.signal })
    .then(async (res) => (res.ok ? ((await res.json()) as { version?: string }).version ?? null : null))
    .then((latest) => (latest ? save(latest) : undefined))
    .catch(() => {});
  const finish = async () => {
    await Promise.race([check, new Promise<void>((resolve) => setTimeout(resolve, 300).unref())]);
    controller.abort();
  };
  return { notice, finish };
}
