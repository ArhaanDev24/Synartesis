import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync, renameSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { SecretStore } from "./settings.js";

/**
 * Signing in, and what it is actually for.
 *
 * The journal already records who approved a call. Without an account that is
 * the string "you", which is fine on one laptop and useless the moment anybody
 * asks who let an irreversible call through. Signing in makes the record name
 * a person. That is the whole of it: there is no server here, nothing syncs,
 * and the app works exactly as well signed out.
 *
 * Four things are deliberate:
 *
 * The sign-in happens in the person's own browser, not in a window this app
 * draws. An application that renders Google's password field can read what is
 * typed into it, and no amount of good intent changes that. A loopback
 * redirect is what RFC 8252 asks native applications to do, and this does it.
 *
 * There is no client secret, because a desktop application cannot keep one --
 * it ships inside the download. PKCE is what replaces it.
 *
 * Only `openid email profile` is asked for. Not Drive, not Gmail, not
 * anything that would make this a program with access to somebody's account.
 *
 * And no token is kept. The id token is read once, for the name on it, and
 * then dropped along with everything else. Nothing here can be stolen later
 * because after the first second there is nothing here to steal.
 */

export interface Account {
  readonly name: string;
  readonly email: string;
  readonly picture?: string;
}

export interface GoogleOptions {
  /**
   * The OAuth client id, which belongs to whoever builds this. There is no
   * default: a client id baked into the source would be one anybody could
   * point at their own application.
   */
  readonly clientId: string;
  /** Hands a URL to the person's browser. Injected so a test can answer it. */
  readonly open: (url: string) => Promise<void> | void;
  /** Overridden in tests; the real ones are Google's. */
  readonly authEndpoint?: string;
  readonly tokenEndpoint?: string;
  /** How long to wait for somebody to finish in the browser. */
  readonly timeoutMs?: number;
}

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const SCOPE = "openid email profile";
const WAIT_MS = 180_000;

function base64url(raw: Buffer): string {
  return raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The claims out of an id token.
 *
 * Not verified against Google's signing keys, and it does not need to be: this
 * token did not arrive from anywhere: it came back on our own TLS connection
 * to Google's token endpoint, in reply to a code only this process could
 * redeem. Verifying a signature on something we just fetched ourselves proves
 * nothing extra. It would matter if the token had been handed to us by
 * somebody else, and it never is.
 */
export function claims(idToken: string): Account | undefined {
  const middle = idToken.split(".")[1];
  if (middle === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(middle, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const email = text(parsed["email"]);
  if (email === undefined) {
    return undefined;
  }
  const picture = text(parsed["picture"]);
  return {
    name: text(parsed["name"]) ?? email,
    email,
    ...(picture === undefined ? {} : { picture }),
  };
}

/** The one page the browser is sent back to, and the last thing it shows. */
function landing(good: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>Synartesis</title>
<style>
  html{background:#5e1420;color:#f6e9e5;font:16px/1.6 -apple-system,system-ui,sans-serif}
  body{display:grid;place-items:center;height:100vh;margin:0;text-align:center}
  p{max-width:34ch}
</style>
<body><div>
  <h1 style="font-weight:300;letter-spacing:.06em;text-transform:uppercase">Synartesis</h1>
  <p>${good ? "You are signed in. You can close this tab." : "That did not work. You can close this tab and try again."}</p>
</div></body>`;
}

/**
 * Sign in, once, through the browser.
 *
 * Resolves with the person's name and address, having kept nothing else.
 */
export async function signInWithGoogle(options: GoogleOptions): Promise<Account> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  /**
   * The address is held from the moment it is known, not read back later.
   *
   * The token exchange has to quote the same redirect_uri the authorisation
   * used, and Google compares them exactly -- but by then the listener has
   * been closed, and a closed server reports no address at all.
   */
  const held: { server?: Server; redirect?: string } = {};
  const code = await new Promise<string>((settle, fail) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const given = url.searchParams.get("state");
      const granted = url.searchParams.get("code");
      // Checked before anything is done with the code. Without this, a link
      // somebody else made could complete a sign-in this app started.
      const ok = given === state && granted !== null;
      response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      response.end(landing(ok));
      if (ok) {
        settle(granted);
      } else {
        fail(new Error(url.searchParams.get("error") ?? "the browser came back without a code"));
      }
    });
    held.server = server;
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("could not listen for the reply"));
        return;
      }
      const redirect = `http://127.0.0.1:${String(address.port)}/callback`;
      held.redirect = redirect;
      const authorize = new URL(options.authEndpoint ?? AUTH);
      for (const [key, value] of Object.entries({
        client_id: options.clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        // So somebody can pick a different account rather than being silently
        // signed back into the one the browser already had.
        prompt: "select_account",
      })) {
        authorize.searchParams.set(key, value);
      }
      void options.open(authorize.toString());
    });

    setTimeout(() => {
      fail(new Error("nobody finished signing in"));
    }, options.timeoutMs ?? WAIT_MS).unref();
  }).finally(() => {
    held.server?.close();
  });

  const answer = await fetch(options.tokenEndpoint ?? TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: held.redirect ?? "",
    }),
  });
  if (!answer.ok) {
    throw new Error(`Google refused the sign-in (HTTP ${String(answer.status)}).`);
  }
  const body: unknown = await answer.json();
  const idToken = isRecord(body) ? text(body["id_token"]) : undefined;
  const account = idToken === undefined ? undefined : claims(idToken);
  if (account === undefined) {
    throw new Error("Google did not say who that was.");
  }
  // And that is the last of it. The access token in `body` is not stored, not
  // refreshed and not used: this app wanted a name, and it has one.
  return account;
}

/**
 * Where the name is kept between runs.
 *
 * Sealed with the operating system's keychain like anything else here. It is
 * only a name and an address, but it is a person's name and address, and a
 * plain file is a plain file.
 */
export class Signed {
  #who: Account | undefined;

  constructor(
    private readonly path: string,
    private readonly secrets: SecretStore,
  ) {
    this.#who = this.#read();
  }

  #read(): Account | undefined {
    let sealed: string;
    try {
      sealed = readFileSync(this.path, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(this.secrets.open(sealed));
      if (!isRecord(parsed)) return undefined;
      const email = text(parsed["email"]);
      if (email === undefined) return undefined;
      const picture = text(parsed["picture"]);
      return {
        name: text(parsed["name"]) ?? email,
        email,
        ...(picture === undefined ? {} : { picture }),
      };
    } catch {
      // Sealed by a different machine or a different user, or corrupted.
      // Either way it cannot be read, and being signed out is the right
      // answer rather than an error on startup.
      return undefined;
    }
  }

  get who(): Account | undefined {
    return this.#who;
  }

  /** The name to record against an approval. */
  get actor(): string {
    return this.#who?.email ?? "you";
  }

  keep(account: Account): void {
    this.#who = account;
    mkdirSync(dirname(this.path), { recursive: true });
    const beside = `${this.path}.writing`;
    writeFileSync(beside, this.secrets.seal(JSON.stringify(account)), { mode: 0o600 });
    renameSync(beside, this.path);
  }

  forget(): void {
    this.#who = undefined;
    rmSync(this.path, { force: true });
  }
}
