import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClient, readTokenResponse } from "../src/api.js";
import { checkApiUrl, credentialsPath, writeCredentials } from "../src/config.js";
import { clean, safeJson } from "../src/errors.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tempDir = () => mkdtemp(join(tmpdir(), "clonvo-sec-"));

describe("API URL", () => {
  it("allows https, and http only on this computer, and keeps only the origin", () => {
    expect(checkApiUrl("https://api.clonvo.com/v1?x=1")).toBe("https://api.clonvo.com");
    expect(checkApiUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(checkApiUrl("http://localhost:5191/")).toBe("http://localhost:5191");
    expect(() => checkApiUrl("http://api.clonvo.com")).toThrow("must use https");
    expect(() => checkApiUrl("https://user:pw@api.clonvo.com")).toThrow("username or password");
    expect(() => checkApiUrl("file:///etc/passwd")).toThrow("must use https");
    expect(() => checkApiUrl("not a url")).toThrow("isn't a URL");
  });
});

describe("credentials file", () => {
  it.skipIf(process.platform === "win32")("refuses a folder other users can write to", async () => {
    const dir = await tempDir();
    await chmod(dir, 0o777);
    await expect(writeCredentials({ type: "key", apiUrl: "https://api.clonvo.com", apiKey: "k" }, { CLONVO_CONFIG_DIR: dir })).rejects.toThrow("can be written by other users");
  });

  it.skipIf(process.platform === "win32")("replaces a planted link instead of writing through it", async () => {
    const dir = await tempDir();
    await chmod(dir, 0o700);
    const target = join(await tempDir(), "elsewhere.json");
    await writeFile(target, "untouched");
    const env = { CLONVO_CONFIG_DIR: dir };
    await symlink(target, credentialsPath(env));
    await writeCredentials({ type: "key", apiUrl: "https://api.clonvo.com", apiKey: "k" }, env);
    expect(await readFile(target, "utf8")).toBe("untouched");
    expect((await lstat(credentialsPath(env))).isSymbolicLink()).toBe(false);
    expect((await lstat(credentialsPath(env))).mode & 0o777).toBe(0o600);
  });
});

describe("renewing a sign-in", () => {
  it("uses tokens another terminal just renewed instead of spending the old refresh token", async () => {
    const dir = await tempDir();
    await chmod(dir, 0o700);
    const env = { CLONVO_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    const now = 1_000_000;
    await writeCredentials({ type: "oauth", apiUrl: "https://api.test", accessToken: "cv_at_old", refreshToken: "cv_rt_old", expiresAt: now + 10_000 }, env);
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      seen.push(`${new URL(req.url).pathname} ${req.headers.get("authorization") ?? ""}`);
      return json(200, { data: {} });
    };
    const client = await createClient({ env, fetch: fetchImpl, now: () => now });
    // Another terminal renews after this one read the file.
    await writeCredentials({ type: "oauth", apiUrl: "https://api.test", accessToken: "cv_at_other", refreshToken: "cv_rt_other", expiresAt: now + 3_600_000 }, env);
    await client.request("GET", "/v1/key");
    expect(seen).toEqual(["/v1/key Bearer cv_at_other"]);
  });

  it("passes real 401s through instead of calling them a lost sign-in", async () => {
    const dir = await tempDir();
    await chmod(dir, 0o700);
    const env = { CLONVO_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
    await writeCredentials({ type: "oauth", apiUrl: "https://api.test", accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }, env);
    const client = await createClient({ env, fetch: async () => json(401, { error: { message: "This API key belongs to an archived project.", code: "project_archived" } }) });
    await expect(client.request("GET", "/v1/key")).rejects.toMatchObject({ message: "This API key belongs to an archived project.", code: "project_archived" });
  });

  it("rejects a token response without what it needs", () => {
    expect(() => readTokenResponse({ access_token: "a", refresh_token: "r" }, "https://api.test", 0)).toThrow("doesn't understand");
    expect(readTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 60 }, "https://api.test", 0).expiresAt).toBe(60_000);
  });
});

describe("terminal output", () => {
  it("strips escape sequences from text and escapes them in JSON", () => {
    expect(clean("ok\x1b]8;;https://evil\x07link\x1b]8;;\x07 \u009b31m done\n")).toBe("ok]8;;https://evillink]8;; 31m done\n");
    expect(safeJson({ title: "a\u009b31mb\x1bc‮" }, true)).toBe('{"title":"a\\u009b31mb\\u001bc\\u202e"}');
  });
});
