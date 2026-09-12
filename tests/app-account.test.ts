import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claims, Signed, signInWithGoogle } from "../app/main/account.js";
import type { SecretStore } from "../app/main/settings.js";

/**
 * Signing in, checked without signing anybody in.
 *
 * The flow is tested against a stand-in for Google, because the parts that can
 * be wrong are all on this side: whether the code challenge is really derived
 * from the verifier, whether the state is checked before the code is used,
 * whether the redirect quoted at the token endpoint is the one the browser was
 * actually sent to, and whether anything is kept afterwards that should not be.
 *
 * None of that needs a Google account, and none of it would be exercised by
 * one -- a successful sign-in looks the same whether or not the state was
 * checked. That is exactly why it is written down here.
 */

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((settle) => server.close(() => { settle(); }));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function plain(): SecretStore {
  return {
    available: () => true,
    seal: (raw) => Buffer.from(raw, "utf8").toString("base64"),
    open: (raw) => Buffer.from(raw, "base64").toString("utf8"),
  };
}

/** An id token shaped like Google's: three parts, only the middle read. */
function idToken(payload: Record<string, unknown>): string {
  const middle = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `header.${middle}.signature`;
}

interface Google {
  readonly url: string;
  /** Every form the application posted to the token endpoint. */
  readonly posted: URLSearchParams[];
}

/**
 * A stand-in for Google's token endpoint.
 *
 * It answers any code with the same person, and records what it was sent so a
 * test can look at it -- which is the point, since what leaves the machine is
 * the half that has to be right.
 */
async function google(
  answer: (form: URLSearchParams) => { status: number; body: unknown },
): Promise<Google> {
  const posted: URLSearchParams[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      posted.push(form);
      const reply = answer(form);
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  servers.push(server);
  await new Promise<void>((settle) => {
    server.listen(0, "127.0.0.1", settle);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${String(address.port)}/token`, posted };
}

const PERSON = { email: "arhaan@example.com", name: "Arhaan", picture: "https://x/y.png" };

function ok(): { status: number; body: unknown } {
  return { status: 200, body: { access_token: "at-secret", id_token: idToken(PERSON) } };
}

describe("signing in with Google", () => {
  it("asks the browser for a code, and trades it for a name", async () => {
    const fake = await google(() => ok());
    const seen: string[] = [];

    const who = await signInWithGoogle({
      clientId: "test-client.apps.googleusercontent.com",
      authEndpoint: "http://127.0.0.1:1/auth",
      tokenEndpoint: fake.url,
      // What the browser would do: follow the URL to the redirect on it.
      open: async (url) => {
        seen.push(url);
        const asked = new URL(url);
        const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", "granted-code");
        back.searchParams.set("state", asked.searchParams.get("state") ?? "");
        await fetch(back.toString());
      },
    });

    expect(who).toEqual(PERSON);

    const asked = new URL(seen[0] ?? "");
    // Nothing beyond a name. Not Drive, not Gmail, nothing that would make
    // this a program with access to somebody's account.
    expect(asked.searchParams.get("scope")).toBe("openid email profile");
    expect(asked.searchParams.get("code_challenge_method")).toBe("S256");
    // A desktop application cannot keep a secret -- it ships inside the
    // download -- so there must not be one anywhere in this exchange.
    expect(seen.join(" ")).not.toMatch(/client_secret/);
    expect(fake.posted[0]?.get("client_secret")).toBeNull();
  });

  it("proves it started the exchange it is finishing", async () => {
    const fake = await google(() => ok());
    let sentChallenge = "";
    await signInWithGoogle({
      clientId: "c",
      authEndpoint: "http://127.0.0.1:1/auth",
      tokenEndpoint: fake.url,
      open: async (url) => {
        const asked = new URL(url);
        sentChallenge = asked.searchParams.get("code_challenge") ?? "";
        const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", "granted-code");
        back.searchParams.set("state", asked.searchParams.get("state") ?? "");
        await fetch(back.toString());
      },
    });

    // The verifier sent at the end must be the one the challenge was made
    // from, or PKCE is decoration. Recomputed here rather than trusted.
    const verifier = fake.posted[0]?.get("code_verifier") ?? "";
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifier).not.toBe("");
    expect(expected).toBe(sentChallenge);
  });

  it("quotes the address the browser was actually sent to", async () => {
    const fake = await google(() => ok());
    let redirect = "";
    await signInWithGoogle({
      clientId: "c",
      authEndpoint: "http://127.0.0.1:1/auth",
      tokenEndpoint: fake.url,
      open: async (url) => {
        const asked = new URL(url);
        redirect = asked.searchParams.get("redirect_uri") ?? "";
        const back = new URL(redirect);
        back.searchParams.set("code", "granted-code");
        back.searchParams.set("state", asked.searchParams.get("state") ?? "");
        await fetch(back.toString());
      },
    });
    // Compared exactly by Google, and read back from a listener that has been
    // closed by then -- which reports no address at all.
    expect(fake.posted[0]?.get("redirect_uri")).toBe(redirect);
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("refuses a reply it did not start", async () => {
    const fake = await google(() => ok());
    const attempt = signInWithGoogle({
      clientId: "c",
      authEndpoint: "http://127.0.0.1:1/auth",
      tokenEndpoint: fake.url,
      timeoutMs: 3000,
      open: async (url) => {
        const back = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", "code-from-somewhere-else");
        // Somebody else's state. A link anybody could have made.
        back.searchParams.set("state", "not-the-one-we-sent");
        await fetch(back.toString());
      },
    });
    await expect(attempt).rejects.toThrow();
    // And it never went near the token endpoint with that code.
    expect(fake.posted).toHaveLength(0);
  });

  it("keeps nothing but the name", async () => {
    const fake = await google(() => ok());
    const root = mkdtempSync(join(tmpdir(), "synartesis-account-"));
    dirs.push(root);
    const path = join(root, "account.sealed");

    const who = await signInWithGoogle({
      clientId: "c",
      authEndpoint: "http://127.0.0.1:1/auth",
      tokenEndpoint: fake.url,
      open: async (url) => {
        const asked = new URL(url);
        const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", "granted-code");
        back.searchParams.set("state", asked.searchParams.get("state") ?? "");
        await fetch(back.toString());
      },
    });

    const signed = new Signed(path, plain());
    signed.keep(who);

    const stored = readFileSync(path, "utf8");
    // The access token came back in the same reply and is not kept: this app
    // wanted a name, and there is nothing here to steal afterwards.
    expect(Buffer.from(stored, "base64").toString("utf8")).not.toContain("at-secret");
    expect(JSON.stringify(who)).not.toContain("at-secret");
  });
});

describe("who the journal names", () => {
  it("says 'you' until somebody signs in", () => {
    const root = mkdtempSync(join(tmpdir(), "synartesis-account-"));
    dirs.push(root);
    const signed = new Signed(join(root, "account.sealed"), plain());
    expect(signed.actor).toBe("you");
    signed.keep(PERSON);
    // Which is the whole point of signing in: an approval recorded against a
    // person rather than against whoever happened to be at the keyboard.
    expect(signed.actor).toBe("arhaan@example.com");
    signed.forget();
    expect(signed.actor).toBe("you");
  });

  it("comes back signed in after a restart, and out if the seal will not open", () => {
    const root = mkdtempSync(join(tmpdir(), "synartesis-account-"));
    dirs.push(root);
    const path = join(root, "account.sealed");
    new Signed(path, plain()).keep(PERSON);
    expect(new Signed(path, plain()).who).toEqual(PERSON);

    // Sealed on another machine, or by another user, or simply corrupted.
    const broken: SecretStore = {
      available: () => true,
      seal: (raw) => raw,
      open: () => {
        throw new Error("this is not mine to open");
      },
    };
    // Signed out, rather than an error on startup.
    expect(new Signed(path, broken).who).toBeUndefined();
  });

  it("reads a name out of an id token, and refuses one without an address", () => {
    expect(claims(idToken(PERSON))?.email).toBe("arhaan@example.com");
    expect(claims(idToken({ name: "Nobody" }))).toBeUndefined();
    expect(claims("not-a-token")).toBeUndefined();
    // No name on it: the address is the name, rather than an empty label.
    expect(claims(idToken({ email: "a@b.c" }))?.name).toBe("a@b.c");
  });
});
