import { PearContextError, type PearRequestContext } from "@pear-agent/cloudflare";
import { z } from "zod";

import { sanitizeReturnTo } from "./redirect.js";

export type AuthEnv = {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_CALLBACK_URL?: string;
  SESSION_SECRET?: string;
  PEAR_LOCAL_DEV_AUTH?: string;
};

export type AuthUser = {
  id: string;
  login: string;
  name: string;
  avatarUrl: string;
};

type SessionPayload = AuthUser & { expiresAt: number };
type OAuthState = { state: string; verifier: string; returnTo: string; expiresAt: number };

const githubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullable(),
  avatar_url: z.string().url(),
});

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });

const encoder = new TextEncoder();
const SESSION_COOKIE = "cook_session";
const OAUTH_COOKIE = "cook_oauth";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function seal(value: unknown, secret: string): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify(value)));
  return `${payload}.${await hmac(payload, secret)}`;
}

async function unseal<T>(token: string, secret: string): Promise<T | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = await hmac(payload, secret);
  if (signature.length !== expected.length) return null;
  let mismatch = 0;
  for (let index = 0; index < signature.length; index += 1) {
    mismatch |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (mismatch !== 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as T;
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | null {
  const pair = request.headers
    .get("cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

function cookie(name: string, value: string, maxAge: number, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function requireSecret(env: AuthEnv): string {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new PearContextError("Authentication is not configured");
  }
  return env.SESSION_SECRET;
}

export async function readSession(request: Request, env: AuthEnv): Promise<AuthUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const session = await unseal<SessionPayload>(token, requireSecret(env));
  if (!session || session.expiresAt <= Date.now() || !session.id || !session.login) return null;
  return {
    id: session.id,
    login: session.login,
    name: session.name,
    avatarUrl: session.avatarUrl,
  };
}

export async function resolveAuthenticatedContext(
  request: Request,
  env: AuthEnv,
): Promise<PearRequestContext> {
  const user = await readSession(request, env);
  if (!user) throw new PearContextError("Sign in with GitHub to continue");
  return {
    actorId: `github:${user.id}`,
    roles: ["cook"],
    claims: { login: user.login },
  };
}


export async function handleAuthRequest(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/auth/session") {
    const user = await readSession(request, env);
    return Response.json({ user }, { status: user ? 200 : 401 });
  }

  if (url.pathname === "/auth/logout" && request.method === "POST") {
    return Response.json(
      { ok: true },
      { headers: { "set-cookie": cookie(SESSION_COOKIE, "", 0, request) } },
    );
  }

  if (url.pathname === "/auth/local" && request.method === "POST") {
    const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!localHost || env.PEAR_LOCAL_DEV_AUTH !== "true") {
      return Response.json({ error: "Local sign-in is disabled" }, { status: 404 });
    }
    const payload: SessionPayload = {
      id: "local-cook",
      login: "local-cook",
      name: "Local Cook",
      avatarUrl: "",
      expiresAt: Date.now() + 8 * 60 * 60 * 1_000,
    };
    return Response.json(
      { user: payload },
      {
        headers: {
          "set-cookie": cookie(SESSION_COOKIE, await seal(payload, requireSecret(env)), 8 * 60 * 60, request),
        },
      },
    );
  }

  if (url.pathname === "/auth/github") {
    if (!env.GITHUB_CLIENT_ID) {
      return Response.json({ error: "GitHub login is not configured" }, { status: 503 });
    }
    const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
    const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"));
    const oauthState: OAuthState = {
      state,
      verifier,
      returnTo,
      expiresAt: Date.now() + 10 * 60 * 1_000,
    };
    const callbackUrl = env.GITHUB_CALLBACK_URL || `${url.origin}/auth/github/callback`;
    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.search = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: callbackUrl,
      state,
      code_challenge: base64Url(new Uint8Array(digest)),
      code_challenge_method: "S256",
      scope: "read:user",
    }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        location: authorizeUrl.toString(),
        "set-cookie": cookie(OAUTH_COOKIE, await seal(oauthState, requireSecret(env)), 10 * 60, request),
      },
    });
  }

  if (url.pathname === "/auth/github/callback") {
    const stored = cookieValue(request, OAUTH_COOKIE);
    const oauthState = stored ? await unseal<OAuthState>(stored, requireSecret(env)) : null;
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!oauthState || oauthState.expiresAt <= Date.now() || oauthState.state !== state || !code) {
      return Response.json({ error: "GitHub login state is invalid or expired" }, { status: 400 });
    }
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return Response.json({ error: "GitHub login is not configured" }, { status: 503 });
    }
    const callbackUrl = env.GITHUB_CALLBACK_URL || `${url.origin}/auth/github/callback`;
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl,
        code_verifier: oauthState.verifier,
      }),
    });
    if (!tokenResponse.ok) {
      return Response.json({ error: "GitHub token exchange failed" }, { status: 502 });
    }
    const token = tokenResponseSchema.parse(await tokenResponse.json());
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token.access_token}`,
        "user-agent": "Pear-Cook",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!userResponse.ok) {
      return Response.json({ error: "GitHub profile lookup failed" }, { status: 502 });
    }
    const github = githubUserSchema.parse(await userResponse.json());
    const session: SessionPayload = {
      id: String(github.id),
      login: github.login,
      name: github.name || github.login,
      avatarUrl: github.avatar_url,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
    };
    const responseHeaders = new Headers({ location: oauthState.returnTo });
    responseHeaders.append(
      "set-cookie",
      cookie(
        SESSION_COOKIE,
        await seal(session, requireSecret(env)),
        7 * 24 * 60 * 60,
        request,
      ),
    );
    responseHeaders.append("set-cookie", cookie(OAUTH_COOKIE, "", 0, request));
    return new Response(null, { status: 302, headers: responseHeaders });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
