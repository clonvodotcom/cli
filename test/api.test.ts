import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/api.js";
import { credentialsPath, writeCredentials } from "../src/config.js";
import { VERSION } from "../src/version.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function envWith(credentials?: Parameters<typeof writeCredentials>[0]) {
  const env = { CLONVO_CONFIG_DIR: await mkdtemp(join(tmpdir(), "clonvo-cli-")) } as NodeJS.ProcessEnv;
  if (credentials) await writeCredentials(credentials, env);
  return env;
}

describe("createClient", () => {
  it("prefers CLONVO_API_KEY and sends it as a bearer token", async () => {
    const env = { ...(await envWith({ type: "key", apiUrl: "https://saved.test", apiKey: "sk-saved" })), CLONVO_API_KEY: "sk-env", CLONVO_API_URL: "https://env.test/" };
    let seen: Request | undefined;
    const client = await createClient({ env, fetch: async (input, init) => ((seen = new Request(input, init)), json(200, { ok: true })) });
    await client.request("GET", "/v1/key");
    expect(seen?.url).toBe("https://env.test/v1/key");
    expect(seen?.headers.get("authorization")).toBe("Bearer sk-env");
    expect(seen?.headers.get("user-agent")).toContain(`clonvo-cli/${VERSION}`);
  });

  it("asks you to sign in when there are no credentials", async () => {
    await expect(createClient({ env: await envWith() })).rejects.toMatchObject({ code: "signed_out" });
  });

  it("refreshes a browser sign-in shortly before it expires, and saves the new tokens privately", async () => {
    const now = 1_000_000;
    const env = await envWith({ type: "oauth", apiUrl: "https://api.test", accessToken: "cv_at_old", refreshToken: "cv_rt_old", expiresAt: now + 30_000 });
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("authorization") ?? (await req.text())}`);
      if (req.url.endsWith("/oauth/token")) return json(200, { access_token: "cv_at_new", refresh_token: "cv_rt_new", expires_in: 3600 });
      return json(200, { data: {} });
    };
    const client = await createClient({ env, fetch: fetchImpl, now: () => now });
    await client.request("GET", "/v1/credits");
    expect(seen[0]).toContain("POST /oauth/token grant_type=refresh_token&client_id=clonvo-cli&refresh_token=cv_rt_old");
    expect(seen[1]).toBe("GET /v1/credits Bearer cv_at_new");
    const saved = JSON.parse(await readFile(credentialsPath(env), "utf8"));
    expect(saved).toMatchObject({ accessToken: "cv_at_new", refreshToken: "cv_rt_new", expiresAt: now + 3_600_000 });
    if (process.platform !== "win32") expect((await stat(credentialsPath(env))).mode & 0o777).toBe(0o600);
  });

  it("retries once with a fresh token on 401, then says the sign-in ended", async () => {
    const env = await envWith({ type: "oauth", apiUrl: "https://api.test", accessToken: "cv_at_a", refreshToken: "cv_rt_a", expiresAt: Date.now() + 3_600_000 });
    let refreshes = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/oauth/token")) return refreshes++ ? json(400, { error: "invalid_grant" }) : json(200, { access_token: "cv_at_b", refresh_token: "cv_rt_b", expires_in: 3600 });
      return json(401, { error: { message: "This access token is invalid or has expired.", code: "invalid_token" } });
    };
    const client = await createClient({ env, fetch: fetchImpl });
    await expect(client.request("GET", "/v1/key")).rejects.toThrow("Your sign-in has ended");
    expect(refreshes).toBe(1);
  });

  it("passes the gateway's error message through", async () => {
    const env = { ...(await envWith()), CLONVO_API_KEY: "sk-x" };
    const client = await createClient({ env, fetch: async () => json(400, { error: { message: "query is required.", code: "invalid_tool_arguments" } }) });
    await expect(client.request("POST", "/v1/tools/web_search", {})).rejects.toMatchObject({ message: "query is required.", status: 400, code: "invalid_tool_arguments" });
  });
});

describe("package", () => {
  it("reports the version in package.json", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
