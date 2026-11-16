// Where the CLI keeps its sign-in, and which Clonvo it talks to.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ClonvoError } from "./errors.js";

export const DEFAULT_API_URL = "https://api.clonvo.com";
export const CLIENT_ID = "clonvo-cli";

/** A browser sign-in (OAuth tokens), or an API key saved with `clonvo login --with-key`. */
export type Credentials =
  | { type: "oauth"; apiUrl: string; accessToken: string; refreshToken: string; expiresAt: number }
  | { type: "key"; apiUrl: string; apiKey: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * An API origin that's safe to send credentials to: https, or http only on this computer (local development).
 * Returns the origin alone, so nothing else in the value reaches a URL or a command.
 */
export function checkApiUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClonvoError(`CLONVO_API_URL isn't a URL: "${value}".`);
  }
  if (url.username || url.password) throw new ClonvoError("CLONVO_API_URL can't contain a username or password.");
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return url.origin;
  throw new ClonvoError("CLONVO_API_URL must use https (http is allowed only for localhost), so your credentials aren't sent in the clear.");
}

export function apiUrl(env: NodeJS.ProcessEnv = process.env) {
  return checkApiUrl(env.CLONVO_API_URL || DEFAULT_API_URL);
}

/** $CLONVO_CONFIG_DIR, else the platform's config folder: ~/.config/clonvo, or %APPDATA%\clonvo on Windows. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  if (env.CLONVO_CONFIG_DIR) return env.CLONVO_CONFIG_DIR;
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "clonvo");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "clonvo");
}

export const credentialsPath = (env: NodeJS.ProcessEnv = process.env) => join(configDir(env), "cli-credentials.json");

export async function readCredentials(env: NodeJS.ProcessEnv = process.env): Promise<Credentials | null> {
  let text: string;
  try {
    text = await readFile(credentialsPath(env), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text) as Credentials;
    // A saved URL is checked like CLONVO_API_URL, so an edited file can't send tokens over plain http.
    if (value?.type === "oauth" && typeof value.accessToken === "string" && typeof value.refreshToken === "string") return { ...value, apiUrl: checkApiUrl(value.apiUrl) };
    if (value?.type === "key" && typeof value.apiKey === "string") return { ...value, apiUrl: checkApiUrl(value.apiUrl) };
  } catch {
    // A damaged file reads as signed out; the next login replaces it.
  }
  return null;
}

/** Refuses a config folder other users can write to, where someone could swap the file or plant a link. */
async function privateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const info = await stat(dir);
  if (info.mode & 0o022) throw new ClonvoError(`${dir} can be written by other users, so the CLI won't keep your sign-in there. Run \`chmod 700 ${dir}\`, or set CLONVO_CONFIG_DIR to a private folder.`);
}

/**
 * Written readable by this user only, and atomically: a new file created with mode 0600, then renamed over the old
 * one. The rename replaces a link rather than writing through it.
 */
export async function writeCredentials(credentials: Credentials, env: NodeJS.ProcessEnv = process.env) {
  const path = credentialsPath(env);
  await privateDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(credentials, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function deleteCredentials(env: NodeJS.ProcessEnv = process.env) {
  await rm(credentialsPath(env), { force: true });
}

/** A lock held while refreshing, so two terminals don't both spend the same refresh token. */
export async function withCredentialsLock<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const path = `${credentialsPath(env)}.lock`;
  await privateDir(dirname(path));
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await (await open(path, "wx", 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A lock left by a process that died mid-refresh.
      const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > 30_000) await rm(path, { force: true });
      else if (Date.now() > deadline) throw new ClonvoError(`Another clonvo command is renewing your sign-in. If none is running, delete ${path} and try again.`);
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await run();
  } finally {
    await rm(path, { force: true });
  }
}
