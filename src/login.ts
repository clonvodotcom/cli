// `clonvo login`: OAuth 2.1 authorization code with PKCE and a loopback redirect (RFC 8252). The browser signs in to
// Clonvo, you pick the project calls bill to, and Clonvo sends the code back to a one-time server on 127.0.0.1.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { errorFrom, postForm, readTokenResponse } from "./api.js";
import { CLIENT_ID, deleteCredentials, readCredentials, writeCredentials } from "./config.js";
import { clean, ClonvoError } from "./errors.js";

/** Clonvo keeps a sign-in request open for 10 minutes. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

const base64url = (buffer: Buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl(apiUrl: string, params: { redirectUri: string; challenge: string; state: string }) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: params.redirectUri,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: params.state,
  });
  return `${apiUrl}/oauth/authorize?${query}`;
}

/**
 * Opens the URL in the default browser, without a shell: on Windows through url.dll rather than `cmd start`, whose
 * parsing of & and % would mangle the URL. Only https and loopback http URLs are opened. Resolves false when there's
 * no browser to open.
 */
export function openBrowser(url: string): Promise<boolean> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))) return Promise.resolve(false);
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3eee4;color:#1c1b19;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:28rem;padding:2rem}h1{font:500 2rem/1.15 Georgia,ui-serif,serif;margin:0 0 .75rem;letter-spacing:-.01em}p{margin:0;color:#57534b}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

interface Callback {
  code: string;
}

/** A one-time server on 127.0.0.1 that waits for Clonvo's redirect. */
async function listenForCallback(state: string, issuer: string): Promise<{ redirectUri: string; result: Promise<Callback>; close: () => void }> {
  let settle!: { resolve: (value: Callback) => void; reject: (error: Error) => void };
  const result = new Promise<Callback>((resolve, reject) => (settle = { resolve, reject }));
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const reply = (status: number, title: string, body: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page(title, body));
    };
    if (url.searchParams.get("state") !== state) {
      reply(400, "This sign-in doesn't match", "Go back to your terminal and run <code>clonvo login</code> again.");
      return;
    }
    // RFC 9207: the code must come from the server we sent you to.
    const iss = url.searchParams.get("iss");
    if (iss !== null && iss.replace(/\/+$/, "") !== issuer) {
      reply(400, "This sign-in came from somewhere else", "Nothing was connected. Go back to your terminal and run <code>clonvo login</code> again.");
      settle.reject(new ClonvoError(`The sign-in came back from ${clean(iss)}, not ${issuer}. Nothing was saved.`));
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      reply(200, "Sign-in cancelled", "Nothing was connected. You can close this tab.");
      settle.reject(new ClonvoError(error === "access_denied" ? "Sign-in was cancelled in the browser." : clean(url.searchParams.get("error_description") || error), 0, error));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      reply(400, "Something's missing", "Clonvo didn't send a sign-in code. Run <code>clonvo login</code> again.");
      return;
    }
    reply(200, "You're signed in", "The Clonvo CLI is connected. You can close this tab and go back to your terminal.");
    settle.resolve({ code });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(() => settle.reject(new ClonvoError("Sign-in timed out after 10 minutes. Run `clonvo login` again.")), LOGIN_TIMEOUT_MS);
  timer.unref();
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  };
  return { redirectUri: `http://127.0.0.1:${port}/callback`, result, close };
}

export async function exchangeCode(apiUrl: string, input: { code: string; redirectUri: string; verifier: string }, fetchImpl: typeof fetch = fetch, now = Date.now) {
  const res = await postForm(fetchImpl, `${apiUrl}/oauth/token`, { grant_type: "authorization_code", client_id: CLIENT_ID, code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier });
  if (!res.ok) throw await errorFrom(res);
  return readTokenResponse(await res.json(), apiUrl, now());
}

export async function browserLogin(apiUrl: string, options: { openBrowser: boolean; log: (line: string) => void }) {
  const state = base64url(randomBytes(16));
  const { verifier, challenge } = pkcePair();
  const callback = await listenForCallback(state, apiUrl);
  try {
    const url = authorizeUrl(apiUrl, { redirectUri: callback.redirectUri, challenge, state });
    const opened = options.openBrowser && (await openBrowser(url));
    options.log(opened ? "Opened your browser to sign in to Clonvo. If it didn't open, visit:" : "Open this link in a browser on this computer to sign in to Clonvo:");
    options.log(`  ${url}`);
    options.log("Waiting for you to approve…");
    const { code } = await callback.result;
    const credentials = await exchangeCode(apiUrl, { code, redirectUri: callback.redirectUri, verifier });
    // Each sign-in is its own connection, so the one this replaces is ended rather than left behind.
    await revokeSaved();
    await writeCredentials(credentials);
    return credentials;
  } finally {
    callback.close();
  }
}

/** Ends the saved sign-in on Clonvo's side too (best effort), then forgets it. */
export async function revokeSaved(fetchImpl: typeof fetch = fetch) {
  const saved = await readCredentials();
  if (saved?.type === "oauth") {
    // Revoking the refresh token ends this computer's connection, with its access token. Other computers have their own.
    await postForm(fetchImpl, `${saved.apiUrl}/oauth/revoke`, { client_id: CLIENT_ID, token: saved.refreshToken }, AbortSignal.timeout(5_000)).catch(() => {});
  }
  await deleteCredentials();
  return saved;
}
