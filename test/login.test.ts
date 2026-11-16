import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeUrl, exchangeCode, pkcePair } from "../src/login.js";

describe("login", () => {
  it("makes an S256 PKCE pair Clonvo accepts", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
  });

  it("asks for a code for the CLI client with a loopback redirect", () => {
    const url = new URL(authorizeUrl("https://api.clonvo.com", { redirectUri: "http://127.0.0.1:5555/callback", challenge: "c".repeat(43), state: "s" }));
    expect(url.origin + url.pathname).toBe("https://api.clonvo.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "clonvo-cli",
      redirect_uri: "http://127.0.0.1:5555/callback",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      state: "s",
    });
  });

  it("exchanges the code for tokens", async () => {
    let body = "";
    const creds = await exchangeCode(
      "https://api.test",
      { code: "cv_code_x", redirectUri: "http://127.0.0.1:1/callback", verifier: "v" },
      async (_input, init) => ((body = String(init?.body)), new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }))),
      () => 0,
    );
    expect(new URLSearchParams(body).get("grant_type")).toBe("authorization_code");
    expect(new URLSearchParams(body).get("code_verifier")).toBe("v");
    expect(creds).toEqual({ type: "oauth", apiUrl: "https://api.test", accessToken: "a", refreshToken: "r", expiresAt: 3_600_000 });
  });
});
