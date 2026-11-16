// HTTP to Clonvo: picks the credentials, refreshes a browser sign-in when it's about to expire, and turns the
// gateway's error envelope into a ClonvoError with a message a person can act on.
import { apiUrl, CLIENT_ID, readCredentials, withCredentialsLock, writeCredentials, type Credentials } from "./config.js";
import { clean, ClonvoError } from "./errors.js";
import { debug } from "./term.js";
import { VERSION } from "./version.js";

export { ClonvoError } from "./errors.js";

export const NOT_SIGNED_IN = "You're not signed in. Run `clonvo login`, or set CLONVO_API_KEY.";
const SIGN_IN_ENDED = "Your sign-in has ended or was disconnected. Run `clonvo login` again.";

/** Refresh this long before the access token expires, so a call never starts with a token about to lapse. */
const REFRESH_EARLY_MS = 60_000;

type OAuthCredentials = Extract<Credentials, { type: "oauth" }>;

export interface ClientOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface Client {
  baseUrl: string;
  /** "key" for an API key from CLONVO_API_KEY or `login --with-key`, "oauth" for a browser sign-in. */
  mode: "key" | "oauth";
  request<T>(method: string, path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<{ status: number; data: T; headers: Headers }>;
}

export const userAgent = () => `clonvo-cli/${VERSION} (node ${process.versions.node}; ${process.platform})`;

/** The gateway's `{ error: { message, code } }`, or OAuth's `{ error, error_description }`. Messages are cleaned for the terminal. */
export async function errorFrom(res: Response): Promise<ClonvoError> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: { message?: string; code?: string | null } | string; error_description?: string };
    if (body.error && typeof body.error === "object" && typeof body.error.message === "string") return new ClonvoError(clean(body.error.message), res.status, body.error.code ?? null);
    if (typeof body.error === "string") return new ClonvoError(clean(body.error_description || body.error), res.status, body.error);
  } catch {
    // Not JSON: fall through to the status line.
  }
  return new ClonvoError(`Clonvo answered ${res.status}${res.statusText ? ` ${clean(res.statusText)}` : ""}.`, res.status);
}

/** A token response, checked before anything is saved. */
export function readTokenResponse(body: unknown, apiUrl: string, now: number): OAuthCredentials {
  const b = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof b?.access_token !== "string" || !b.access_token || typeof b.refresh_token !== "string" || !b.refresh_token || typeof b.expires_in !== "number" || !(b.expires_in > 0)) {
    throw new ClonvoError("Clonvo sent back a sign-in response the CLI doesn't understand. Run `clonvo login` again.");
  }
  return { type: "oauth", apiUrl, accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt: now + b.expires_in * 1000 };
}

/** A fetch that logs the method, URL, status and time with --debug. Never headers or bodies, which hold tokens. */
export async function traced(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  const started = Date.now();
  debug(`→ ${init.method ?? "GET"} ${url}`);
  try {
    const res = await fetchImpl(url, init);
    debug(`← ${res.status} ${init.method ?? "GET"} ${url} (${Date.now() - started}ms)`);
    return res;
  } catch (error) {
    debug(`✗ ${init.method ?? "GET"} ${url}: ${(error as Error).message}`);
    throw error;
  }
}

/** POSTs a form to Clonvo's OAuth endpoints. Redirects are refused so a token can't be forwarded anywhere. */
export const postForm = (fetchImpl: typeof fetch, url: string, form: Record<string, string>, signal?: AbortSignal) =>
  traced(fetchImpl, url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() }, body: new URLSearchParams(form).toString(), redirect: "error", signal });

/**
 * Renews a browser sign-in. Holds a lock and re-reads the saved sign-in first, so when another terminal has just
 * renewed it, this one uses those tokens instead of spending the old refresh token again.
 */
export async function refreshTokens(credentials: OAuthCredentials, options: ClientOptions = {}): Promise<OAuthCredentials> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return withCredentialsLock(env, async () => {
    const saved = await readCredentials(env);
    const current = saved?.type === "oauth" && saved.apiUrl === credentials.apiUrl ? saved : credentials;
    if (current.refreshToken !== credentials.refreshToken && current.expiresAt - REFRESH_EARLY_MS > now()) return current;
    const res = await postForm(fetchImpl, `${current.apiUrl}/oauth/token`, { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: current.refreshToken });
    if (!res.ok) {
      const error = await errorFrom(res);
      if (error.code === "invalid_grant" || error.code === "invalid_client") throw new ClonvoError(SIGN_IN_ENDED, 401, "signed_out");
      throw error;
    }
    const next = readTokenResponse(await res.json(), current.apiUrl, now());
    await writeCredentials(next, env);
    return next;
  });
}

/** A client for the signed-in user. CLONVO_API_KEY wins over a saved sign-in, so CI and scripts never need a login. */
export async function createClient(options: ClientOptions = {}): Promise<Client> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const envKey = env.CLONVO_API_KEY?.trim();
  let credentials: Credentials | null = envKey ? { type: "key", apiUrl: apiUrl(env), apiKey: envKey } : await readCredentials(env);
  if (!credentials) throw new ClonvoError(NOT_SIGNED_IN, 401, "signed_out");
  const baseUrl = credentials.apiUrl;

  // One renewal at a time within this process (whoami makes two requests at once).
  let renewing: Promise<OAuthCredentials> | null = null;
  const renew = (from: OAuthCredentials) => {
    renewing ??= refreshTokens(from, { env, fetch: fetchImpl, now }).finally(() => (renewing = null));
    return renewing;
  };

  const bearer = async (force = false) => {
    if (credentials!.type === "key") return credentials!.apiKey;
    if (force || credentials!.expiresAt - REFRESH_EARLY_MS <= now()) credentials = await renew(credentials!);
    return (credentials as OAuthCredentials).accessToken;
  };

  async function request<T>(method: string, path: string, body?: unknown, init: { signal?: AbortSignal } = {}) {
    const send = async (token: string) =>
      traced(fetchImpl, `${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "user-agent": userAgent(), accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Never follow a redirect with the token attached.
        redirect: "error",
        signal: init.signal,
      });
    const oauth = credentials!.type === "oauth";
    let res = await send(await bearer());
    let error = res.ok ? null : await errorFrom(res);
    // An access token that expired or was revoked early: renew once and retry. Other 401s (a disabled key, an
    // archived project) are real answers and pass through as they are.
    if (oauth && error?.status === 401 && error.code === "invalid_token") {
      res = await send(await bearer(true));
      error = res.ok ? null : await errorFrom(res);
      if (error?.status === 401 && error.code === "invalid_token") throw new ClonvoError(SIGN_IN_ENDED, 401, "signed_out");
    }
    if (error) throw error;
    const text = await res.text();
    let data: T;
    try {
      data = (text ? JSON.parse(text) : null) as T;
    } catch {
      throw new ClonvoError(`Clonvo sent a response that isn't JSON (${res.status}). Try again in a moment.`, res.status);
    }
    return { status: res.status, data, headers: res.headers };
  }

  return { baseUrl, mode: credentials.type, request };
}
