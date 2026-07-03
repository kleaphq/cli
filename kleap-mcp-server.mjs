#!/usr/bin/env node
/**
 * Kleap MCP server (v1 — stdio transport, API-key auth).
 *
 * Lets ANY MCP client (Claude Desktop, Cursor, or ChatGPT via a bridge) drive
 * Kleap: create / list / inspect apps, edit them through Kleap's own AI, and
 * PUBLISH with the verified-live guarantee. It does this by wrapping the
 * existing public REST API (`/api/v1/*`) — the MCP is just another client onto
 * the same backend, exactly like the web app or the WhatsApp integration. No
 * new write path, so every Kleap convention/guardrail still applies server-side.
 *
 * Auth: a Kleap API key, sent as `Authorization: Bearer kleap_live_sk_...`.
 * Transport: stdio (the client spawns this process).
 *
 * Run:
 *   KLEAP_API_KEY=kleap_live_sk_... node mcp/kleap-mcp-server.mjs
 *   (optional) KLEAP_API_URL=https://kleap.co   # default
 *
 * PHASE 2 (deliberately NOT here — see the agent-platform plan):
 *   remote HTTP transport + OAuth (so users add it without a local process),
 *   registry listing + one-click install, and metering/quota surfacing. This
 *   file is the working keystone of the agent interface: it proves the whole
 *   path (external agent → Kleap backend → verified-live publish) end to end.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  isNumericId,
  formatAppLine,
  formatListLine,
  formatDomainLine,
  findApexARecord,
  HELP,
} from "./lib/format.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(
  readFileSync(join(__dirname, "package.json"), "utf8"),
).version;

const API_URL = (process.env.KLEAP_API_URL || "https://kleap.co").replace(
  /\/$/,
  "",
);

// Auth token used on every API call. Resolved at boot (below): an explicit
// KLEAP_API_KEY env var wins; otherwise the OAuth token saved by
// `kleap auth login`. Mutable so a refresh can swap it in.
let AUTH_TOKEN = null;

// ── Stored credentials (~/.kleap/config.json) ───────────────────────────────
const CONFIG_DIR = join(homedir(), ".kleap");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {}
}

// ── OAuth (browser, PKCE + http loopback, RFC 8252) — `kleap auth login` ─────
const OAUTH_SCOPES = "apps:read apps:create apps:update messages:create tasks:read";
const b64url = (buf) =>
  Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
function openBrowser(url) {
  const plat = process.platform;
  const cmd = plat === "darwin" ? "open" : plat === "win32" ? "cmd" : "xdg-open";
  const args = plat === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {}
}
// SECURITY: `base` is passed explicitly on every call so each credential
// exchange is pinned to a deliberate origin — authLogin() to the endpoint the
// user is knowingly signing in to (API_URL), refreshIfNeeded() to the origin
// the stored credential was ISSUED by (cfg.oauth.api_url), never an env
// override. Deriving the target from the global API_URL here is what made
// KLEAP_API_URL exfiltrate stored refresh tokens.
async function oauthPost(base, path, payload) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = json?.error_description || json?.error || text.slice(0, 200);
    throw new Error(`${path} → HTTP ${res.status}: ${msg}`);
  }
  return json || {};
}
async function authLogin() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  // 1. bind a loopback server first so we know the redirect port
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  // 2. register a native client (Dynamic Client Registration) for that redirect
  const reg = await oauthPost(API_URL, "/api/oauth/register", {
    client_name: "Kleap CLI",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  const clientId = reg.client_id;
  // 3. wait for the browser to redirect back with the code
  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        server.close();
      } catch {}
      reject(new Error("login timed out after 5 minutes"));
    }, 300000);
    server.on("request", (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const st = u.searchParams.get("state");
      res.writeHead(err ? 400 : 200, {
        "Content-Type": "text/html; charset=utf-8",
      });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;text-align:center;padding:64px;color:#111"><h2 style="color:${err ? "#cc0033" : "#16b364"}">${err ? "Sign-in failed" : "Kleap connected"}</h2><p>${err ? "Return to the terminal and try again." : "You can close this tab and return to the terminal."}</p></body>`,
      );
      clearTimeout(timer);
      try {
        server.close();
      } catch {}
      if (err) return reject(new Error(err));
      if (st !== state) return reject(new Error("state mismatch (possible CSRF)"));
      resolve(code);
    });
  });
  // 4. open the browser to the authorize page
  const authUrl =
    `${API_URL}/api/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
    `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
  console.error(
    "[kleap] Opening your browser to sign in…\n[kleap] If it doesn't open, paste this URL:\n" +
      authUrl +
      "\n",
  );
  openBrowser(authUrl);
  const code = await codePromise;
  // 5. exchange the code for tokens (PKCE)
  const tok = await oauthPost(API_URL, "/api/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const cfg = readConfig();
  cfg.oauth = {
    client_id: clientId,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
    api_url: API_URL,
  };
  writeConfig(cfg);
  console.error(
    "[kleap] Signed in. Token saved to ~/.kleap/config.json — `npx @eliottd/kleap` now works with no API key.",
  );
}
// The origin a stored OAuth credential is bound to: the endpoint it was
// issued by at `kleap auth login` time (older configs predate the field —
// they were always issued by kleap.co).
function oauthOrigin(o) {
  return (o?.api_url || "https://kleap.co").replace(/\/$/, "");
}
async function refreshIfNeeded(cfg) {
  const o = cfg.oauth;
  if (!o) return null;
  if (!o.refresh_token || !o.expires_at) return o.access_token || null;
  if (o.expires_at > Date.now() + 60000) return o.access_token; // still valid
  try {
    // SECURITY: the refresh_token is ONLY ever sent to the origin that issued
    // it (cfg.oauth.api_url) — never to a KLEAP_API_URL env override. A
    // malicious/typo'd KLEAP_API_URL must not be able to capture long-lived
    // credentials or poison the cached access_token.
    const tok = await oauthPost(oauthOrigin(o), "/api/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: o.refresh_token,
      client_id: o.client_id,
    });
    o.access_token = tok.access_token;
    if (tok.refresh_token) o.refresh_token = tok.refresh_token;
    o.expires_at = tok.expires_in ? Date.now() + tok.expires_in * 1000 : null;
    writeConfig(cfg);
    return o.access_token;
  } catch {
    return o.access_token; // fall back; the server will 401 if it's truly dead
  }
}
async function resolveToken() {
  if (process.env.KLEAP_API_KEY) return process.env.KLEAP_API_KEY; // explicit key wins
  const cfg = readConfig();
  if (cfg.oauth?.access_token) {
    // SECURITY (origin binding): a stored OAuth token is only usable against
    // the origin it was issued by. If KLEAP_API_URL points anywhere else,
    // REFUSE — sending the Bearer there would hand the session to an
    // arbitrary host. Explicit secrets (KLEAP_API_KEY env, `kleap auth key`)
    // are a different trust model: the user knowingly provided that secret
    // for whatever endpoint they configure, so those still work below.
    if (oauthOrigin(cfg.oauth) !== API_URL) {
      if (cfg.apiKey) return cfg.apiKey; // explicit stored key: fine for custom endpoints
      const err = new Error(
        `stored login is bound to ${oauthOrigin(cfg.oauth)} but KLEAP_API_URL is ${API_URL} — ` +
          "unset KLEAP_API_URL, or use KLEAP_API_KEY / `kleap auth key` for custom endpoints",
      );
      err.code = "CREDENTIAL_ORIGIN_MISMATCH";
      throw err;
    }
    return await refreshIfNeeded(cfg);
  }
  if (cfg.apiKey) return cfg.apiKey; // `kleap auth key <KEY>` fallback (no browser)
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

/**
 * Thin REST caller — auth, timeout, bounded retry, JSON/HTML-aware errors.
 * Retries transient failures (5xx / 429 / network / timeout) with backoff.
 * Never surfaces raw HTML error pages to the agent; extracts error.code/message.
 */
async function api(method, path, body, { retries = 2, timeoutMs = 60000 } = {}) {
  const url = `${API_URL}/api/v1${path}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(t);

      const ctype = res.headers.get("content-type") || "";
      const text = await res.text();
      const isJson = ctype.includes("application/json");
      const parsed = isJson ? safeJson(text) : null;

      if (!res.ok) {
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          // Honor Retry-After when the server sends one (seconds form,
          // capped at 60s); otherwise fall back to exponential backoff.
          const ra = Number(res.headers.get("retry-after"));
          await sleep(
            Number.isFinite(ra) && ra > 0
              ? Math.min(ra, 60) * 1000
              : 400 * 2 ** attempt,
          );
          continue;
        }
        const detail =
          parsed?.error?.message ||
          parsed?.message ||
          (isJson
            ? JSON.stringify(parsed).slice(0, 300)
            : `non-JSON ${ctype || "response"} (likely an unhandled route)`);
        const code = parsed?.error?.code ? ` [${parsed.error.code}]` : "";
        throw new Error(`Kleap API ${res.status}${code} on ${method} ${path}: ${detail}`);
      }

      if (!isJson) {
        throw new Error(`Kleap API returned non-JSON (${ctype}) for ${method} ${path}`);
      }
      return parsed;
    } catch (e) {
      clearTimeout(t);
      lastErr =
        e?.name === "AbortError"
          ? new Error(`Kleap API timeout after ${timeoutMs}ms on ${method} ${path}`)
          : e;
      const retryable =
        e?.name === "AbortError" ||
        e?.code === "ECONNRESET" ||
        e?.code === "ETIMEDOUT" ||
        /fetch failed|network/i.test(e?.message || "");
      if (retryable && attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

const num = (description) => ({ type: "number", description });
const str = (description) => ({ type: "string", description });
const obj = (properties, required) => ({
  type: "object",
  properties: properties || {},
  ...(required ? { required } : {}),
  additionalProperties: false,
});

/**
 * The tool surface. Each maps 1:1 to an existing /api/v1 endpoint.
 *
 * Tool names + argument names are kept IDENTICAL to the hosted remote server
 * (/api/mcp) on purpose, so an agent (or a tutorial) written for one transport
 * works verbatim on the other. Arguments are snake_case (app_id, task_id).
 */
const TOOLS = [
  {
    name: "list_apps",
    description:
      "List the Kleap apps (websites) owned by the authenticated account, newest first. Returns a `pagination` object {total, limit, offset, has_more, next_offset}: the server caps `limit` at 100, so when `has_more` is true, page with `next_offset`. To find ONE site by its domain / URL / slug, use find_app instead of paging through everything.",
    inputSchema: obj({
      limit: num("Max apps to return (default 50, server max 100)."),
      offset: num("Pagination offset (default 0)."),
      q: str("Optional filter on app name or slug (substring match)."),
    }),
    handler: ({ limit, offset, q } = {}) => {
      const params = new URLSearchParams();
      if (limit != null) params.set("limit", String(limit));
      if (offset != null) params.set("offset", String(offset));
      if (q) params.set("q", q);
      const qs = params.toString();
      return api("GET", `/apps${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "find_app",
    description:
      "Resolve a website the user names by its ADDRESS — a custom domain (\"serrureriesk.ch\"), a kleap.io URL (\"mysite.kleap.io\"), or a bare slug (\"mysite\") — to one of your apps in ONE call. Use this FIRST whenever the user refers to a site by its domain/URL instead of an app id, then pass the returned app_id to get_app / modify_app / publish_app. Do not list every app and scan. Returns NOT_FOUND if no owned app matches (the site may not be on this account or not connected yet) — then fall back to list_apps.",
    inputSchema: obj(
      { query: str("A domain, URL, or slug, e.g. 'serrureriesk.ch'.") },
      ["query"],
    ),
    handler: ({ query }) =>
      api("GET", `/apps/resolve?q=${encodeURIComponent(query)}`),
  },
  {
    name: "get_app",
    description:
      "Get one Kleap app's metadata: status, slug, production_url, published state. Use this for general app info at any time. To specifically confirm a deploy/publish, use get_publish_status.",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("GET", `/apps/${app_id}`),
  },
  {
    name: "list_app_files",
    description:
      "List the source file PATHS of a Kleap app (names only — no contents). Use it to inspect the project structure, then read_files to get the actual contents before editing. To CHANGE files: read_files → edit with your model → write_files → publish_app (deterministic), or modify_app (you describe the change and Kleap's AI writes it).",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("GET", `/apps/${app_id}/files`),
  },
  {
    name: "read_files",
    description:
      "Read the FULL CONTENTS of existing files so you can edit them SAFELY instead of rewriting blind (which risks breaking shared components/homepages). This closes the loop: list_app_files → read_files → edit the exact text with YOUR model → write_files → publish_app. Use it to fix headers/footers, wrong phone numbers, broken links, dead forms, etc. Pass one or many paths. Allowed with a Read-only key. Returns { files: [{ path, content, type, bytes }], missing: [paths not found] }.",
    inputSchema: obj(
      {
        app_id: num("The app id."),
        paths: {
          type: "array",
          description:
            "Project-relative file paths to read, from list_app_files (e.g. ['src/components/Header.astro','src/components/Footer.astro']).",
          items: { type: "string" },
        },
      },
      ["app_id", "paths"],
    ),
    handler: ({ app_id, paths }) =>
      api(
        "GET",
        `/apps/${encodeURIComponent(app_id)}/files?paths=${encodeURIComponent(
          (Array.isArray(paths) ? paths : [paths]).join(","),
        )}`,
      ),
  },
  {
    name: "write_files",
    description:
      "Write source files DIRECTLY — YOUR agent's model generates the code, Kleap just stores, builds and deploys it. No Kleap-AI generation step, so it is DETERMINISTIC, uses NO Kleap credits, and never stalls (unlike asking an AI to build). Use this to scaffold exact files/pages — e.g. programmatic-SEO routes — instead of relying on modify_app. Paths are project-relative; these are Astro sites (src/pages/*.astro, src/data/*.json, src/components/*.astro, public/*). Overwrites by path. AFTER writing, call publish_app to build & go live. (Prefer modify_app when you'd rather Kleap's AI figure out the change.)",
    inputSchema: obj(
      {
        app_id: num("The app id."),
        files: {
          type: "array",
          description:
            "Files to write/overwrite. Each is { path, content }. path is project-relative (e.g. 'src/pages/services/[city].astro'); content is the full file text.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      },
      ["app_id", "files"],
    ),
    handler: ({ app_id, files }) =>
      api("PUT", `/apps/${encodeURIComponent(app_id)}/files`, { files }),
  },
  {
    name: "create_app",
    description:
      "Create a new Kleap website (an Astro site) from a natural-language prompt. Returns app_id + task_id immediately; poll check_task until status='completed' (~5-15 min). The site auto-builds and goes LIVE on completion — no separate publish needed for the first version.",
    inputSchema: obj(
      {
        prompt: str("What the website should be."),
        visibility: str("'public' (discoverable) or 'personal' (private)."),
        webhook_url: str(
          "Optional HTTPS URL that Kleap POSTs when the build finishes — use it for a hands-off flow instead of polling check_task.",
        ),
      },
      ["prompt"],
    ),
    handler: ({ prompt, visibility, webhook_url }) =>
      api("POST", "/apps", {
        prompt,
        visibility: visibility || "personal",
        ...(webhook_url ? { webhook_url } : {}),
      }),
  },
  {
    name: "modify_app",
    description:
      "Ask a Kleap app's AI to change it — describe the OUTCOME you want (edit copy, add a section or page, fix a bug); the AI writes the files (you cannot write files yourself). Returns a task — poll check_task. For MANY similar pages (programmatic SEO), ask in ONE call for a single dynamic Astro route + a data file, NOT one page per call.",
    inputSchema: obj(
      {
        app_id: num("The app id."),
        message: str("The change to make."),
        webhook_url: str(
          "Optional HTTPS URL that Kleap POSTs when the edit finishes — for a hands-off flow instead of polling check_task.",
        ),
      },
      ["app_id", "message"],
    ),
    handler: ({ app_id, message, webhook_url }) =>
      api("POST", `/apps/${app_id}/messages`, {
        message,
        ...(webhook_url ? { webhook_url } : {}),
      }),
  },
  {
    name: "rename_app",
    description:
      "Rename an app's display name. This does NOT change its URL — the live address ({slug}.kleap.io) and any links to it stay intact. (There is no delete tool, by design.)",
    inputSchema: obj(
      { app_id: num("The app id."), name: str("The new display name.") },
      ["app_id", "name"],
    ),
    handler: ({ app_id, name }) =>
      api("PATCH", `/apps/${app_id}`, { name }),
  },
  {
    name: "check_task",
    description:
      "Check an async create/modify task. By default it LONG-POLLS: the call holds for up to 'wait' seconds and returns the moment the task finishes — so you wait efficiently instead of hammering this every few seconds through a 5-15 min build. Just call it again if status is still queued/processing. status is one of: queued, processing, completed, failed. On 'completed' the change is built and LIVE (app_id + production_url available). On 'failed', error.code is TASK_TIMEOUT or STALE_TASK (the build STALLED — transient — call retry_task, which returns a NEW task_id to poll) or TASK_FAILED (generation failed — read error.message; retry_task once, and if it repeats, stop and tell the user). (Out-of-credits is not a task failure — create_app/modify_app reject up front with 402 INSUFFICIENT_CREDITS.)",
    inputSchema: obj(
      {
        task_id: str("The task id."),
        wait: num(
          "Seconds to long-poll, 0-50 (default 45). The call returns early the instant the task reaches completed/failed. Use 0 for an immediate snapshot.",
        ),
      },
      ["task_id"],
    ),
    handler: ({ task_id, wait }) => {
      const w = wait == null ? 45 : Math.min(Math.max(Number(wait) || 0, 0), 50);
      return api(
        "GET",
        `/tasks/${encodeURIComponent(task_id)}?wait=${w}`,
        undefined,
        { timeoutMs: (w + 15) * 1000 },
      );
    },
  },
  {
    name: "retry_task",
    description:
      "Resume a failed/stalled create/modify task from where it stopped (partial files preserved). Use when check_task reports 'failed', instead of starting a brand-new create_app. Returns a NEW task_id — poll check_task on that NEW id (not the original). Budget: retry TASK_TIMEOUT/STALE_TASK up to TWICE; retry TASK_FAILED only ONCE; then stop and tell the user. NEVER retry a non-transient error (402 INSUFFICIENT_CREDITS, a rejected prompt) — it just fails again.",
    inputSchema: obj({ task_id: str("The failed task id to resume.") }, [
      "task_id",
    ]),
    handler: ({ task_id }) => api("POST", `/tasks/${task_id}/retry`, {}),
  },
  {
    name: "publish_app",
    description:
      "Build & publish an app to its live URL, with the VERIFIED-LIVE guarantee: only reported live once provably serving (else 'not confirmed live' — never a false positive). REQUIRED after write_files (that stores files but does not deploy). NOT needed after create_app/modify_app (those auto-deploy on completion). Returns a deploy handle; poll get_publish_status. If it reports not-confirmed-live, keep polling get_publish_status — do not loop publish_app.",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("POST", `/apps/${app_id}/publish`, {}),
  },
  {
    name: "get_publish_status",
    description:
      "Confirm whether an app is actually published and live (production_url + published state) — use this to answer \"is it live yet?\", typically after publish_app. For general app metadata use get_app instead.",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("GET", `/apps/${app_id}/publish`),
  },
  {
    name: "get_credits",
    description:
      "Check the authenticated account's remaining credit balance and plan.",
    inputSchema: obj(),
    handler: () => api("GET", "/account/credits"),
  },
  {
    name: "search_domains",
    description:
      "Search for available domains for a site (e.g. 'mybakery'). Returns available names across TLDs. NOTE: agents cannot buy a domain — purchase is confirmed by the user in Kleap. Use connect_domain for a domain the user already owns.",
    inputSchema: obj(
      {
        query: str("Base name to search, without a TLD (e.g. 'mybakery')."),
        tlds: {
          type: "array",
          items: { type: "string" },
          description: "Optional TLDs to check, e.g. ['.com', '.io', '.ch'].",
        },
      },
      ["query"],
    ),
    handler: ({ query, tlds }) => api("POST", "/domains/search", { query, tlds }),
  },
  {
    name: "check_domain",
    description:
      "Check a domain's connection / DNS status for a Kleap app.",
    inputSchema: obj({ domain: str("The domain, e.g. 'mybakery.com'.") }, [
      "domain",
    ]),
    handler: ({ domain }) =>
      api("GET", `/domains/${encodeURIComponent(domain)}/check`),
  },
  {
    name: "connect_domain",
    description:
      "Connect a domain the user ALREADY OWNS to a live Kleap app (sets up routing + automatic TLS). The app must be live first — a completed create_app/modify_app already counts as published, so you do NOT need to call publish_app first. The response includes a `dns_config` object with the exact A records the user must set at their registrar (+ propagation time) — relay those to the user. Does not buy anything.",
    inputSchema: obj(
      {
        app_id: num("The app id (must be published)."),
        domain: str("The domain to connect, e.g. 'mybakery.com'."),
      },
      ["app_id", "domain"],
    ),
    handler: ({ app_id, domain }) =>
      api("POST", "/domains/connect", { app_id, domain }),
  },
];

const INSTRUCTIONS = `Kleap builds and HOSTS real websites (Astro). You have TWO ways to put code on a site — pick per task:
  • write_files (DETERMINISTIC, recommended when you know the code): YOUR model writes the exact file contents; push them with write_files(app_id, files); Kleap stores, builds and deploys them AS-IS. No Kleap-AI generation step → no Kleap credits, and it never stalls. Best for precise scaffolding: pages, components, data files, programmatic SEO. Then call publish_app to go live.
  • modify_app (Kleap's AI does it): describe the OUTCOME in plain language and Kleap's AI writes the files. Best when you'd rather it figure out the change than write the code yourself.
Either way KLEAP HOSTS the result — build, deploy, SSL, database, auth, forms, custom domains, and the verified-live guarantee. Use list_app_files first to see the project structure (paths only; these are Astro sites: src/pages/*.astro, src/data/*.json, src/components/*.astro, public/*).

TO EDIT AN EXISTING SITE SAFELY — never rewrite a file blind. Do: list_app_files → read_files(app_id, [paths]) to get the CURRENT contents → edit only what must change with your model → write_files the edited files → publish_app. This is the reliable way to fix shared components, headers/footers, wrong phone numbers, broken links, dead forms, etc. (read_files works with a Read-only key, so you can always inspect before changing.) Prefer this read→edit→write loop over modify_app when you need a precise, verifiable change — modify_app hands the edit to Kleap's AI and may not apply exactly what you intend.

THE LOOP
1. Find the site. If the user names it by address ("serrureriesk.ch", "mysite.kleap.io"), call find_app FIRST. If find_app returns NOT_FOUND, the site isn't on this account or isn't connected yet — fall back to list_apps (supports ?q=) or ask the user. Otherwise use list_apps.
2. Build or change it — two paths:
   - DETERMINISTIC (your code): write_files(app_id, [{path, content}, ...]) to push exact files, then publish_app(app_id) to build + deploy. No task, no stall. Best for adding/scaffolding pages you can write yourself.
   - AI (Kleap writes it): create_app(prompt) for a brand-new site, or modify_app(app_id, message) to change one. These return a task_id. Call check_task(task_id) — it LONG-POLLS by default (holds up to 50s, default 45, and returns the instant the build finishes), so just call it again while status is queued/processing. A full build is ~5-15 min, NOT instant, so calling check_task ~10-20 times in a row through one build is EXPECTED — that is normal waiting, not a "loop" (the loop warnings below are only about retrying failed tasks). For a fully hands-off flow, create_app/modify_app also accept a webhook_url that is POSTed when the task finishes.
3. When status="completed", the change is already BUILT AND LIVE at the production URL — create_app and modify_app auto-deploy. (publish_app + get_publish_status only force/verify a re-publish; you normally don't need them after a build.) connect_domain attaches a domain the user already owns (the app must be live first).

ON FAILURE (check_task status="failed"): error.code is one of:
  - TASK_TIMEOUT / STALE_TASK → the build STALLED (transient). Call retry_task(task_id); it returns a NEW task_id — poll check_task on THAT id. Retry up to twice.
  - TASK_FAILED → generation failed. Read error.message; retry_task once. If it repeats, STOP and tell the user. Do NOT loop.

ERRORS BEFORE A TASK STARTS (HTTP errors thrown by create_app/modify_app, with an error.code): 402 INSUFFICIENT_CREDITS (check get_credits and ask the user to top up — do NOT retry), 400 VALIDATION_ERROR (fix the input), 401 UNAUTHORIZED (bad/expired key), 429 RATE_LIMITED (back off, honor Retry-After), 404 NOT_FOUND (wrong app_id — use find_app).

Send ONE coherent change per modify_app call.

MANY PAGES / PROGRAMMATIC SEO — read this before you start:
BEST (deterministic, no stall): use write_files. Generate, with YOUR own model, a dynamic Astro route + a data file, and push them in one write_files call, then publish_app. Example files: src/pages/[service]/[city].astro (a layout that maps over the data) + src/data/locations.json (your full list). One write_files + one publish_app ships every page, scales to thousands, costs no Kleap credits, and cannot stall. This is THE recommended path — especially since asking the AI to scaffold new pages can stall.
ALTERNATIVE (let Kleap's AI do it): ONE modify_app call asking for "a dynamic route src/pages/[service]/[city].astro driven by src/data/locations.json with <your list>, plus a /services index linking them." Never make N create/modify calls (one per page) — that stalls.

rename_app changes only the display name — the live URL never changes. There is no delete tool, by design.

KEYS & SCOPES: this server can't manage API keys. Users create and SCOPE keys in Kleap (Settings -> MCP / API access): pick Read-only, Build, or Full. Read-only allows only the read tools (list_apps, find_app, get_app, list_app_files, read_files, get_publish_status, check_domain, search_domains, get_credits) and a write tool with a read-only key returns 401/403; Build/Full additionally allow create_app, modify_app, write_files, rename_app, publish_app, connect_domain. So for a read-only agent, tell the user to generate a Read-only key there. Buying domains is never included by default.`;

const server = new Server(
  { name: "kleap", version: PKG_VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const result = await tool.handler(req.params.arguments || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${e?.message || e}` }],
    };
  }
});

// ── CLI dispatch ────────────────────────────────────────────────────────────
// Recognized subcommands run and exit with a compact, agent-friendly result
// (1-3 lines, clean exit codes, optional --json). No args — or `kleap mcp` —
// starts the stdio MCP server instead; that's what MCP clients expect, and is
// the unchanged, backward-compatible default.
const TOP_LEVEL_COMMANDS = [
  "auth",
  "create",
  "edit",
  "publish",
  "status",
  "list",
  "domains",
  "screenshot",
  "mcp",
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
];
const cmd = process.argv.slice(2);

function emitOk(line, data, json) {
  if (json) console.log(JSON.stringify(data ?? {}));
  else console.log(line);
  process.exit(0);
}
// EVERY CLI error must exit through here so `--json` is honored on ALL paths
// (API errors, usage errors, auth guards, unknown commands) — an agent that
// JSON.parses the output must never receive bare prose. Convention (same as
// emitOk): JSON on stdout, plain-text `✗ ...` on stderr; exit code 1 either way.
function emitErr(message, json, code) {
  if (json) {
    console.log(JSON.stringify({ error: { ...(code ? { code } : {}), message } }));
  } else {
    console.error(`✗ ${message}`);
  }
  process.exit(1);
}
// THROWS (never prints/exits) so the dispatch's catch — the only place that
// knows about --json — does the formatting via emitErr. Printing + exiting
// directly from here is exactly what caused the "not signed in is always
// plain text even with --json" bug.
async function ensureToken() {
  const t = await resolveToken();
  if (!t) {
    const err = new Error(
      "not signed in — run `kleap auth login` or `kleap auth key <KEY>`",
    );
    err.code = "not_authenticated";
    throw err;
  }
  AUTH_TOKEN = t;
  return t;
}
// Resolve an <app> CLI argument (numeric id, kleap.io slug/URL, or a
// connected custom domain) to a numeric app id via GET /apps/resolve.
async function resolveAppId(appArg) {
  if (isNumericId(appArg)) return Number(appArg);
  const res = await api("GET", `/apps/resolve?q=${encodeURIComponent(appArg)}`);
  const id = res?.app_id ?? res?.id;
  if (!id) throw new Error(`app not found: ${appArg}`);
  return id;
}
// Long-poll a create/modify task to a terminal state (bounded overall wait).
async function pollTask(taskId, { maxWaitMs = 20 * 60 * 1000 } = {}) {
  const start = Date.now();
  let task;
  do {
    task = await api(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}?wait=45`,
      undefined,
      { timeoutMs: 60000 },
    );
    if (task.status === "completed" || task.status === "failed") return task;
  } while (Date.now() - start < maxWaitMs);
  throw new Error(
    `task ${taskId} still ${task.status} after ${Math.round(maxWaitMs / 60000)}min — check again later: kleap status <app>`,
  );
}
// A completed task's result.production_url can briefly be null while the CF
// deploy finishes async (result.deployment_status = "pending") — short-poll
// the app record for it instead of reporting a false "not published".
async function resolveLiveUrl(appId, task) {
  const direct = task?.result?.production_url;
  if (direct) return direct;
  for (let i = 0; i < 6; i++) {
    await sleep(3000);
    const app = await api("GET", `/apps/${appId}`).catch(() => null);
    if (app?.production_url) return app.production_url;
  }
  return null;
}

async function cliCreate(positional, flags) {
  const prompt = positional.join(" ").trim();
  if (!prompt) {
    throw new Error(
      'usage: kleap create "<prompt>" [--visibility public|personal] [--webhook <url>] [--no-wait] [--json]',
    );
  }
  await ensureToken();
  const created = await api("POST", "/apps", {
    prompt,
    visibility: flags.visibility || "personal",
    ...(flags.webhook ? { webhook_url: flags.webhook } : {}),
  });
  if (flags.noWait) {
    return emitOk(
      `… creating app ${created.app_id} (task ${created.task_id}) — kleap status ${created.app_id}`,
      created,
      flags.json,
    );
  }
  const task = await pollTask(created.task_id);
  if (task.status === "failed") {
    throw new Error(`create failed [${task.error?.code}]: ${task.error?.message}`);
  }
  const url = await resolveLiveUrl(created.app_id, task);
  emitOk(
    `✓ created app ${created.app_id} — ${url || `(built, deploy pending — kleap status ${created.app_id})`}`,
    { app_id: created.app_id, task_id: created.task_id, url, task },
    flags.json,
  );
}

async function cliEdit(positional, flags) {
  const [appArg, ...rest] = positional;
  const prompt = rest.join(" ").trim();
  if (!appArg || !prompt) {
    throw new Error(
      'usage: kleap edit <app> "<prompt>" [--webhook <url>] [--no-wait] [--json]',
    );
  }
  await ensureToken();
  const appId = await resolveAppId(appArg);
  const created = await api("POST", `/apps/${appId}/messages`, {
    message: prompt,
    ...(flags.webhook ? { webhook_url: flags.webhook } : {}),
  });
  if (flags.noWait) {
    return emitOk(
      `… editing app ${appId} (task ${created.task_id}) — kleap status ${appId}`,
      created,
      flags.json,
    );
  }
  const task = await pollTask(created.task_id);
  if (task.status === "failed") {
    throw new Error(`edit failed [${task.error?.code}]: ${task.error?.message}`);
  }
  const url = await resolveLiveUrl(appId, task);
  emitOk(
    `✓ edited app ${appId} — ${url || `(built, deploy pending — kleap status ${appId})`}`,
    { app_id: appId, task_id: created.task_id, url, task },
    flags.json,
  );
}

async function cliPublish(positional, flags) {
  const [appArg] = positional;
  if (!appArg) throw new Error("usage: kleap publish <app> [--no-wait] [--json]");
  await ensureToken();
  const appId = await resolveAppId(appArg);
  const started = await api("POST", `/apps/${appId}/publish`, {});
  if (flags.noWait) {
    return emitOk(`… publishing app ${appId}`, started, flags.json);
  }
  const deployKey = started.deploy_key;
  const start = Date.now();
  let last = started;
  while (Date.now() - start < 5 * 60 * 1000) {
    await sleep(4000);
    const q = deployKey ? `?deploy_key=${encodeURIComponent(deployKey)}` : "";
    last = await api("GET", `/apps/${appId}/publish${q}`);
    if (last.status === "published") {
      return emitOk(
        `✓ published ${last.production_url}`,
        { app_id: appId, ...last },
        flags.json,
      );
    }
  }
  throw new Error(
    `not confirmed live after 5min (status: ${last.status}) — recheck: kleap status ${appId}`,
  );
}

async function cliStatus(positional, flags) {
  const [appArg] = positional;
  if (!appArg) throw new Error("usage: kleap status <app> [--json]");
  await ensureToken();
  const appId = await resolveAppId(appArg);
  const app = await api("GET", `/apps/${appId}`);
  emitOk(`✓ ${formatAppLine(app)}`, app, flags.json);
}

async function cliList(positional, flags) {
  await ensureToken();
  const params = new URLSearchParams();
  if (flags.limit) params.set("limit", flags.limit);
  if (flags.q) params.set("q", flags.q);
  const qs = params.toString();
  const res = await api("GET", `/apps${qs ? `?${qs}` : ""}`);
  if (flags.json) {
    console.log(JSON.stringify(res));
    process.exit(0);
  }
  const apps = res.apps || [];
  if (!apps.length) {
    console.log("(no apps)");
    process.exit(0);
  }
  for (const a of apps) console.log(formatListLine(a));
  process.exit(0);
}

async function cliDomainsSearch(positional, flags) {
  const [query] = positional;
  if (!query) {
    throw new Error("usage: kleap domains search <query> [--tlds .com,.io] [--json]");
  }
  await ensureToken();
  const tlds = flags.tlds ? flags.tlds.split(",").map((s) => s.trim()) : undefined;
  const res = await api("POST", "/domains/search", {
    query,
    ...(tlds ? { tlds } : {}),
  });
  if (flags.json) {
    console.log(JSON.stringify(res));
    process.exit(0);
  }
  const available = (res.results || []).filter((r) => r.status === "free");
  if (!available.length) {
    console.log("(no available domains found)");
    process.exit(0);
  }
  for (const r of available) console.log(formatDomainLine(r));
  process.exit(0);
}

async function cliDomainsConnect(positional, flags) {
  const [domain, appArg] = positional;
  if (!domain || !appArg) {
    throw new Error("usage: kleap domains connect <domain> <app> [--json]");
  }
  await ensureToken();
  const appId = await resolveAppId(appArg);
  const res = await api("POST", "/domains/connect", { app_id: appId, domain });
  if (flags.json) {
    console.log(JSON.stringify(res));
    process.exit(0);
  }
  const ip = findApexARecord(res.dns_config);
  console.log(
    `✓ ${domain} pending DNS — point A @ to ${ip || "(see --json)"}, propagation 5-60min`,
  );
  process.exit(0);
}

async function cliScreenshot(positional, flags) {
  const [appArg] = positional;
  if (!appArg) throw new Error("usage: kleap screenshot <app> [--json]");
  await ensureToken();
  const appId = await resolveAppId(appArg);
  const res = await api("GET", `/apps/${appId}/screenshot`);
  emitOk(`✓ ${res.image_url}`, res, flags.json);
}

if (cmd[0] === "help" || cmd[0] === "--help" || cmd[0] === "-h") {
  console.log(HELP(PKG_VERSION));
  process.exit(0);
}
if (cmd[0] === "--version" || cmd[0] === "-v") {
  console.log(PKG_VERSION);
  process.exit(0);
}

if (cmd[0] === "auth") {
  // Parse flags here too — auth guards and usage errors must honor --json
  // like every other command (same bug class as the ensureToken one).
  const { positional: authArgs, flags: authFlags } = parseArgs(cmd.slice(1));
  const sub = authArgs[0];
  if (sub === "login") {
    try {
      await authLogin();
      process.exit(0);
    } catch (e) {
      emitErr(`login failed: ${e?.message || e}`, authFlags.json, "login_failed");
    }
  }
  if (sub === "key") {
    const key = authArgs[1];
    if (!key) {
      emitErr("usage: kleap auth key <KEY>", authFlags.json, "usage");
    }
    const c = readConfig();
    c.apiKey = key;
    writeConfig(c);
    console.error("[kleap] API key saved to ~/.kleap/config.json.");
    process.exit(0);
  }
  if (sub === "logout") {
    // Remove the credential file entirely (not just its keys) — `logout` is
    // the documented way to revoke local access, so nothing may linger.
    try {
      rmSync(CONFIG_PATH, { force: true });
    } catch {}
    console.error("[kleap] Signed out (removed ~/.kleap/config.json).");
    process.exit(0);
  }
  if (sub === "status") {
    let t;
    try {
      t = await resolveToken();
    } catch (e) {
      emitErr(e?.message || String(e), authFlags.json, e?.code);
    }
    if (!t) {
      emitErr(
        "not signed in — run `kleap auth login` or `kleap auth key <KEY>`",
        authFlags.json,
        "not_authenticated",
      );
    }
    const c = readConfig();
    console.error(
      process.env.KLEAP_API_KEY
        ? "[kleap] Authenticated via KLEAP_API_KEY (env)."
        : c.oauth
          ? "[kleap] Signed in via OAuth (~/.kleap/config.json)."
          : "[kleap] Signed in via stored API key (~/.kleap/config.json).",
    );
    process.exit(0);
  }
  emitErr(
    "usage: kleap auth <login|key <KEY>|logout|status>",
    authFlags.json,
    "usage",
  );
}

if (
  ["create", "edit", "publish", "status", "list", "domains", "screenshot"].includes(
    cmd[0],
  )
) {
  const [, ...rest] = cmd;
  const { positional, flags } = parseArgs(rest);
  try {
    if (cmd[0] === "create") await cliCreate(positional, flags);
    else if (cmd[0] === "edit") await cliEdit(positional, flags);
    else if (cmd[0] === "publish") await cliPublish(positional, flags);
    else if (cmd[0] === "status") await cliStatus(positional, flags);
    else if (cmd[0] === "list") await cliList(positional, flags);
    else if (cmd[0] === "screenshot") await cliScreenshot(positional, flags);
    else if (cmd[0] === "domains") {
      const [sub, ...domRest] = positional;
      if (sub === "search") await cliDomainsSearch(domRest, flags);
      else if (sub === "connect") await cliDomainsConnect(domRest, flags);
      else throw new Error("usage: kleap domains <search|connect> ...");
    }
  } catch (e) {
    emitErr(e?.message || String(e), flags.json, e?.code);
  }
}

// Unknown BARE-WORD command → fail fast with usage instead of silently
// trying to speak MCP stdio JSON-RPC on an interactive terminal (protects
// agents from typos). This path too must honor --json.
// BACKWARD COMPAT: a first argument starting with "-" (e.g. `kleap --stdio`)
// falls through to the MCP server, matching 1.1.2 where any non-"auth" argv
// booted the server — existing MCP client configs with extra flags keep
// working.
if (
  cmd.length > 0 &&
  cmd[0] !== "mcp" &&
  !cmd[0].startsWith("-") &&
  !TOP_LEVEL_COMMANDS.includes(cmd[0])
) {
  if (cmd.includes("--json")) {
    emitErr(`unknown command: ${cmd[0]}`, true, "unknown_command");
  }
  console.error(`✗ unknown command: ${cmd[0]}\n\n${HELP(PKG_VERSION)}`);
  process.exit(1);
}

// Default: run the stdio MCP server (`kleap mcp`, or no args — what MCP
// clients invoke). Resolve auth first; a CREDENTIAL_ORIGIN_MISMATCH must be
// a clean refusal here too, not an unhandled rejection.
AUTH_TOKEN = await resolveToken().catch((e) => {
  console.error(`[kleap-mcp] ${e?.message || e}`);
  process.exit(1);
});
if (!AUTH_TOKEN) {
  console.error(
    "[kleap-mcp] Not signed in. Run `npx @eliottd/kleap auth login` (opens your browser, no API key needed),\n" +
      "             or set KLEAP_API_KEY=kleap_live_sk_... (https://kleap.co/settings/api-key).",
  );
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[kleap-mcp] ready (stdio) → ${API_URL}. Tools: ${TOOLS.map((t) => t.name).join(", ")}`,
);
