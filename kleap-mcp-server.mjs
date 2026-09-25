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
  isBinaryPath,
  normalizeDomainQuery,
  normalizeTlds,
  flattenSubmission,
  formatSubmissionLine,
  formatAnalytics,
  formatSearchConsole,
  formatTableLine,
  formatMessageLine,
  parseJsonArg,
  hintFor,
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
// Everything the CLI's commands use. Deliberately NOT domains:purchase (that
// route registers a domain at Kleap's expense) — buying goes through the
// user-paid checkout (domains:checkout).
const OAUTH_SCOPES = [
  "apps:read",
  "apps:create",
  "apps:update",
  "messages:create",
  "tasks:read",
  "forms:read",
  "analytics:read",
  "database:read",
  "database:write",
  "domains:checkout",
].join(" ");
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
    "[kleap] Signed in. Token saved to ~/.kleap/config.json — `npx -y kleap-cli` now works with no API key.",
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

// Identifies the client to Kleap (integrations contract: `kleap-<platform>`).
const USER_AGENT = `kleap-cli/${PKG_VERSION}`;
// Stamped on every create/modify so Kleap can attribute the request.
const SOURCE_METADATA = { source: "kleap-cli" };

/**
 * Thin REST caller — auth, timeout, bounded retry, JSON/HTML-aware errors.
 * Retries transient failures (5xx / 429 / network / timeout) with backoff.
 * Never surfaces raw HTML error pages to the agent; extracts error.code/message.
 *
 * Thrown errors carry the API's structured error: `.code` (e.g.
 * INSUFFICIENT_SCOPE), `.status`, `.details`, `.request_id` and a `.hint`
 * with the actionable next step — and their message starts with
 * `CODE: message`, the format every Kleap integration shows.
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
          "User-Agent": USER_AGENT,
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
        const code = parsed?.error?.code || null;
        const err = new Error(
          `${code ? `${code}: ` : ""}${detail} (HTTP ${res.status}, ${method} ${path.split("?")[0]})`,
        );
        err.isApiError = true;
        err.code = code || `HTTP_${res.status}`;
        err.status = res.status;
        const details = parsed?.error?.details;
        if (details && typeof details === "object" && Object.keys(details).length) {
          err.details = details;
        }
        if (parsed?.error?.request_id) err.request_id = parsed.error.request_id;
        const hint = hintFor(code);
        if (hint) err.hint = hint;
        throw err;
      }

      if (!isJson) {
        throw new Error(`Kleap API returned non-JSON (${ctype}) for ${method} ${path}`);
      }
      return parsed;
    } catch (e) {
      clearTimeout(t);
      if (e?.isApiError) throw e;
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

/** "?a=1&b=2" from an object, skipping null/undefined/"" values. */
function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** app_id for the MCP tools: a number, or any address find_app accepts. */
async function toAppId(app) {
  if (app === undefined || app === null || app === "") {
    throw new Error("app_id is required");
  }
  if (isNumericId(app)) return Number(app);
  const res = await api("GET", `/apps/resolve?q=${encodeURIComponent(String(app))}`);
  const id = res?.app_id ?? res?.id;
  if (!id) throw new Error(`app not found: ${app}`);
  return id;
}

const rowsPath = (appId, table) =>
  `/apps/${appId}/database/tables/${encodeURIComponent(table)}/rows`;

function requireWhere(where, what) {
  if (!where || typeof where !== "object" || Array.isArray(where) || !Object.keys(where).length) {
    const err = new Error(
      `${what} needs a non-empty where object (e.g. {"id": 12}) — refusing to touch every row`,
    );
    err.code = "usage";
    throw err;
  }
}

/** Start a publish; a 409 CONFLICT means one is already running → reuse its deploy_key. */
async function startPublish(appId) {
  try {
    return await api("POST", `/apps/${appId}/publish`, {});
  } catch (e) {
    if (e?.code === "CONFLICT") {
      return {
        id: appId,
        status: "deploying",
        already_running: true,
        deploy_key: e.details?.deploy_key ?? null,
        message: "A deployment was already running — following it instead of starting another.",
      };
    }
    throw e;
  }
}

const num = (description) => ({ type: "number", description });
const str = (description) => ({ type: "string", description });
const bool = (description) => ({ type: "boolean", description });
const anyObj = (description) => ({ type: "object", description, additionalProperties: true });
const obj = (properties, required) => ({
  type: "object",
  properties: properties || {},
  ...(required ? { required } : {}),
  additionalProperties: false,
});
const APP_ID = num("The app id (from list_apps / find_app).");

/**
 * The tool surface. Each maps 1:1 to an existing /api/v1 endpoint.
 *
 * Tool names + argument names are kept IDENTICAL to the hosted remote server
 * (/api/mcp) on purpose, so an agent (or a tutorial) written for one transport
 * works verbatim on the other. Arguments are snake_case (app_id, task_id).
 */
const TOOLS = [
  // ── Apps ──────────────────────────────────────────────────────────────────
  {
    name: "list_apps",
    description:
      "List the Kleap apps (websites) owned by the authenticated account, newest first. Returns a `pagination` object {total, limit, offset, has_more, next_offset}: the server caps `limit` at 100, so when `has_more` is true, page with `next_offset`. To find ONE site by its domain / URL / slug, use find_app instead of paging through everything.",
    inputSchema: obj({
      limit: num("Max apps to return (default 50, server max 100)."),
      offset: num("Pagination offset (default 0)."),
      q: str("Optional filter on app name or slug (substring match)."),
    }),
    handler: ({ limit, offset, q } = {}) => api("GET", `/apps${qs({ limit, offset, q })}`),
  },
  {
    name: "find_app",
    description:
      "Resolve a website the user names by its ADDRESS — a custom domain (\"serrureriesk.ch\"), a kleap.io URL (\"mysite.kleap.io\"), or a bare slug (\"mysite\") — to one of your apps in ONE call. Use this FIRST whenever the user refers to a site by its domain/URL instead of an app id, then pass the returned app_id to the other tools. Returns NOT_FOUND if no owned app matches — then fall back to list_apps.",
    inputSchema: obj(
      { query: str("A domain, URL, or slug, e.g. 'serrureriesk.ch'.") },
      ["query"],
    ),
    handler: ({ query }) => api("GET", `/apps/resolve?q=${encodeURIComponent(query)}`),
  },
  {
    name: "get_app",
    description:
      "Get one Kleap app's metadata: slug, production_url, custom domains, visibility. To specifically confirm a deploy/publish, use get_publish_status.",
    inputSchema: obj({ app_id: APP_ID }, ["app_id"]),
    handler: async ({ app_id }) => api("GET", `/apps/${await toAppId(app_id)}`),
  },
  {
    name: "rename_app",
    description:
      "Rename an app's display name. This does NOT change its URL — the live address ({slug}.kleap.io) and any links to it stay intact. (There is no delete tool, by design.)",
    inputSchema: obj({ app_id: APP_ID, name: str("The new display name.") }, ["app_id", "name"]),
    handler: async ({ app_id, name }) => api("PATCH", `/apps/${await toAppId(app_id)}`, { name }),
  },
  {
    name: "get_screenshot",
    description:
      "Capture (or return the cached) screenshot of an app's site. Returns {image_url, width, height, captured_at, cached} — use it to SEE the result or show it to the user without them opening a browser.",
    inputSchema: obj({ app_id: APP_ID }, ["app_id"]),
    handler: async ({ app_id }) => api("GET", `/apps/${await toAppId(app_id)}/screenshot`),
  },
  {
    name: "wake_app",
    description:
      "Wake a sleeping preview sandbox (legacy Next.js apps). Astro apps have no sandbox and don't need it. Returns the preview_url, ready in ~30-60 s.",
    inputSchema: obj({ app_id: APP_ID }, ["app_id"]),
    handler: async ({ app_id }) => api("POST", `/apps/${await toAppId(app_id)}/wake`, {}),
  },
  // ── AI build / edit ───────────────────────────────────────────────────────
  {
    name: "create_app",
    description:
      "Create a new Kleap website (an Astro site) from a natural-language prompt. Returns app_id + task_id immediately; poll check_task until status='completed' (~1-15 min). The site auto-builds and goes LIVE on completion — no separate publish needed for the first version. Needs ≥5 credits (402 INSUFFICIENT_CREDITS otherwise).",
    inputSchema: obj(
      {
        prompt: str("What the website should be."),
        visibility: str("'personal' (default, private), 'public' (discoverable) or 'workspace'."),
        webhook_url: str("Optional HTTPS URL that Kleap POSTs when the build finishes — a hands-off alternative to polling check_task."),
        idempotency_key: str("Optional key: retrying with the same key returns the same task instead of creating a second app."),
      },
      ["prompt"],
    ),
    handler: ({ prompt, visibility, webhook_url, idempotency_key }) =>
      api("POST", "/apps", {
        prompt,
        visibility: visibility || "personal",
        ...(webhook_url ? { webhook_url } : {}),
        ...(idempotency_key ? { idempotency_key } : {}),
        metadata: { source: "kleap-mcp-stdio" },
      }),
  },
  {
    name: "modify_app",
    description:
      "Ask a Kleap app's AI to change it — describe the OUTCOME you want (edit copy, add a section or page, add a database, fix a bug); Kleap's AI writes the files. Returns a task — poll check_task. For MANY similar pages (programmatic SEO), ask in ONE call for a single dynamic Astro route + a data file, NOT one page per call. For exact, deterministic changes use read_files → edit_files / write_files → publish_app instead. Needs ≥2 credits.",
    inputSchema: obj(
      {
        app_id: APP_ID,
        message: str("The change to make."),
        webhook_url: str("Optional HTTPS URL that Kleap POSTs when the edit finishes."),
        idempotency_key: str("Optional idempotency key."),
      },
      ["app_id", "message"],
    ),
    handler: async ({ app_id, message, webhook_url, idempotency_key }) =>
      api("POST", `/apps/${await toAppId(app_id)}/messages`, {
        message,
        ...(webhook_url ? { webhook_url } : {}),
        ...(idempotency_key ? { idempotency_key } : {}),
        metadata: { source: "kleap-mcp-stdio" },
      }),
  },
  {
    name: "check_task",
    description:
      "Check an async create/modify task. By default it LONG-POLLS: the call holds for up to 'wait' seconds and returns the moment the task finishes — so just call it again while status is queued/processing (10-20 calls through one build is normal). status is one of: queued, processing, completed, failed. On 'completed' the change is built and LIVE (result.production_url). On 'failed', error.code is TASK_TIMEOUT or STALE_TASK (transient — call retry_task, which returns a NEW task_id) or TASK_FAILED (read error.message; retry_task once, and if it repeats, stop and tell the user).",
    inputSchema: obj(
      {
        task_id: str("The task id."),
        wait: num("Seconds to long-poll, 0-50 (default 45). Returns early the instant the task finishes. 0 = immediate snapshot."),
      },
      ["task_id"],
    ),
    handler: ({ task_id, wait }) => {
      const w = wait == null ? 45 : Math.min(Math.max(Number(wait) || 0, 0), 50);
      return api("GET", `/tasks/${encodeURIComponent(task_id)}?wait=${w}`, undefined, {
        timeoutMs: (w + 25) * 1000,
      });
    },
  },
  {
    name: "retry_task",
    description:
      "Resume a failed/stalled create/modify task from where it stopped (partial files preserved). Returns a NEW task_id — poll check_task on that NEW id. Budget: TASK_TIMEOUT/STALE_TASK up to TWICE, TASK_FAILED only ONCE; then stop and tell the user. NEVER retry a non-transient error (402 INSUFFICIENT_CREDITS, a rejected prompt).",
    inputSchema: obj({ task_id: str("The failed task id to resume.") }, ["task_id"]),
    handler: ({ task_id }) => api("POST", `/tasks/${encodeURIComponent(task_id)}/retry`, {}),
  },
  // ── Publish ───────────────────────────────────────────────────────────────
  {
    name: "publish_app",
    description:
      "Build & publish an app to its live URL, with the VERIFIED-LIVE guarantee: only reported live once provably serving. REQUIRED after write_files / edit_files / delete_files / generate_image (those store files but do not deploy). NOT needed after create_app/modify_app (they auto-deploy). Returns a deploy_key; poll get_publish_status. If a deploy is already running, this returns it (already_running:true) instead of failing — do not loop publish_app.",
    inputSchema: obj({ app_id: APP_ID }, ["app_id"]),
    handler: async ({ app_id }) => startPublish(await toAppId(app_id)),
  },
  {
    name: "get_publish_status",
    description:
      "Confirm whether an app is actually published and live. status is published | running | queued | not_published. Once published it carries production_url and a `report` (every internal link checked, JSON-LD/sitemap/robots coverage) — read it instead of re-auditing the site. Pass the deploy_key from publish_app and wait (0-45 s) to long-poll.",
    inputSchema: obj(
      {
        app_id: APP_ID,
        deploy_key: str("Optional deploy_key returned by publish_app."),
        wait: num("Optional seconds to long-poll, 0-45."),
      },
      ["app_id"],
    ),
    handler: async ({ app_id, deploy_key, wait }) => {
      const w = wait == null ? undefined : Math.min(Math.max(Number(wait) || 0, 0), 45);
      return api("GET", `/apps/${await toAppId(app_id)}/publish${qs({ deploy_key, wait: w })}`, undefined, {
        timeoutMs: ((w || 0) + 25) * 1000,
      });
    },
  },
  // ── Files ─────────────────────────────────────────────────────────────────
  {
    name: "list_app_files",
    description:
      "List the source file PATHS of a Kleap app (names only). Astro sites: src/pages/*.astro, src/data/*.json, src/components/*.astro, public/*. Then read_files to get contents before editing.",
    inputSchema: obj({ app_id: APP_ID }, ["app_id"]),
    handler: async ({ app_id }) => api("GET", `/apps/${await toAppId(app_id)}/files`),
  },
  {
    name: "read_files",
    description:
      "Read the FULL CONTENTS of existing files (up to 60 per call) so you edit them SAFELY instead of rewriting blind. Allowed with a Read-only key. Returns { files: [{ path, content, type, bytes }], missing: [paths not found] }.",
    inputSchema: obj(
      {
        app_id: APP_ID,
        paths: { type: "array", items: { type: "string" }, description: "Project-relative paths from list_app_files." },
      },
      ["app_id", "paths"],
    ),
    handler: async ({ app_id, paths }) =>
      api(
        "GET",
        `/apps/${await toAppId(app_id)}/files?paths=${encodeURIComponent(
          (Array.isArray(paths) ? paths : [paths]).join(","),
        )}`,
      ),
  },
  {
    name: "write_files",
    description:
      "Write source files DIRECTLY — YOUR model generates the code, Kleap stores, builds and deploys it as-is (deterministic, no Kleap credits). Use for NEW files or wholesale replacement; for a change inside an existing file use edit_files. Binaries (images, fonts, PDFs) go with encoding:'base64'. Max 512 KB per file. AFTER writing, call publish_app.",
    inputSchema: obj(
      {
        app_id: APP_ID,
        files: {
          type: "array",
          description: "Files to write/overwrite: { path, content, encoding? }.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              encoding: { type: "string", enum: ["base64"], description: "Set to 'base64' for binary content." },
            },
            required: ["path", "content"],
          },
        },
      },
      ["app_id", "files"],
    ),
    handler: async ({ app_id, files }) => api("PUT", `/apps/${await toAppId(app_id)}/files`, { files }),
  },
  {
    name: "edit_files",
    description:
      "Change PART of existing files in place: each edit replaces old_string with new_string (old_string must match exactly and be unique unless replace_all). Read the file with read_files first. Far safer and cheaper than resending a whole file with write_files. Then publish_app.",
    inputSchema: obj(
      {
        app_id: APP_ID,
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              old_string: { type: "string" },
              new_string: { type: "string" },
              replace_all: { type: "boolean" },
            },
            required: ["path", "old_string", "new_string"],
          },
        },
      },
      ["app_id", "edits"],
    ),
    handler: async ({ app_id, edits }) => api("PATCH", `/apps/${await toAppId(app_id)}/files`, { edits }),
  },
  {
    name: "delete_files",
    description:
      "REMOVE pages or assets (never blank a file to 'delete' it — that leaves a URL answering 200 with nothing). Returns the paths actually deleted. The pages stay live until you publish_app.",
    inputSchema: obj(
      { app_id: APP_ID, paths: { type: "array", items: { type: "string" }, description: "Paths to delete." } },
      ["app_id", "paths"],
    ),
    handler: async ({ app_id, paths }) =>
      api("DELETE", `/apps/${await toAppId(app_id)}/files`, { paths: Array.isArray(paths) ? paths : [paths] }),
  },
  {
    name: "generate_image",
    description:
      "Put a REAL generated photo/illustration on the site with no bytes to send: give a vivid prompt and a public/ path ending .png/.jpg/.jpeg/.webp. 768×768 by default (width/height 256-1440); hd:true = premium model. To REPLACE an image, generate to a NEW filename and point the markup at it (same path can be served stale). Then publish_app.",
    inputSchema: obj(
      {
        app_id: APP_ID,
        path: str("public/ image path to create, e.g. public/hero.webp."),
        prompt: str("Vivid description of the image (subject, mood, lighting, style)."),
        width: num("Pixel width 256-1440 (default 768)."),
        height: num("Pixel height 256-1440 (default 768)."),
        hd: bool("true = premium model (sharper, slower)."),
      },
      ["app_id", "path", "prompt"],
    ),
    handler: async ({ app_id, path, prompt, width, height, hd }) =>
      api("POST", `/apps/${await toAppId(app_id)}/generate-image`, {
        path,
        prompt,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(hd ? { hd: true } : {}),
      }, { timeoutMs: 180000, retries: 0 }),
  },
  // ── Leads, traffic, SEO, account ─────────────────────────────────────────
  {
    name: "get_form_submissions",
    description:
      "Read the leads/contacts submitted through the live site's forms, newest first: [{id, submitted_at, data:{...}}]. An empty list is normal for a new site. `since` (ISO 8601, inclusive) returns only newer ones. Needs forms:read — on 403 INSUFFICIENT_SCOPE, the user must create a new API key with the Full preset.",
    inputSchema: obj(
      {
        app_id: APP_ID,
        limit: num("Max rows (default 20, max 100)."),
        since: str("Only submissions at/after this ISO 8601 date."),
      },
      ["app_id"],
    ),
    handler: async ({ app_id, limit, since }) =>
      api("GET", `/apps/${await toAppId(app_id)}/forms${qs({ limit, since })}`),
  },
  {
    name: "get_analytics",
    description:
      "Visitors, pageviews, top pages and referrers of the PUBLISHED site. configured:false means it was never published. Needs analytics:read.",
    inputSchema: obj(
      { app_id: APP_ID, period: { type: "string", enum: ["7d", "30d", "90d"], description: "Window (default 7d)." } },
      ["app_id"],
    ),
    handler: async ({ app_id, period }) =>
      api("GET", `/apps/${await toAppId(app_id)}/analytics${qs({ period })}`),
  },
  {
    name: "get_search_console",
    description:
      "How the site performs IN GOOGLE SEARCH (real Search Console data): clicks, impressions, CTR, position, top queries/pages. Data lags ~2 days. If connected/site_selected is false, call connect_search_console.",
    inputSchema: obj({ app_id: APP_ID }, ["app_id"]),
    handler: async ({ app_id }) => api("GET", `/apps/${await toAppId(app_id)}/search-console`),
  },
  {
    name: "connect_search_console",
    description:
      "Start Google Search Console for a site: returns a consent_url the USER must open in a browser and approve (it cannot be done from here); the property then binds itself. Requires a connected custom domain (requires_custom_domain:true otherwise).",
    inputSchema: obj({ app_id: APP_ID }, ["app_id"]),
    handler: async ({ app_id }) => api("POST", `/apps/${await toAppId(app_id)}/search-console/connect`, {}),
  },
  {
    name: "get_credits",
    description: "The account's remaining credit balance and whether it is on a paid plan.",
    inputSchema: obj(),
    handler: () => api("GET", "/account/credits"),
  },
  // ── Domains ───────────────────────────────────────────────────────────────
  {
    name: "search_domains",
    description:
      "Search available domains for a name (ONE word, no spaces, no TLD — e.g. 'mybakery'). Returns [{domain, status: free|active, price, currency, purchasable}]. To buy one use buy_domain (the USER pays); to attach one the user already owns use connect_domain.",
    inputSchema: obj(
      {
        query: str("Base name without TLD, e.g. 'mybakery'."),
        tlds: { type: "array", items: { type: "string" }, description: "Optional TLDs, e.g. ['.com', '.ch']." },
      },
      ["query"],
    ),
    handler: ({ query, tlds }) =>
      api("POST", "/domains/search", {
        query: normalizeDomainQuery(query),
        ...(Array.isArray(tlds) && tlds.length ? { tlds: normalizeTlds(tlds.join(",")) } : {}),
      }),
  },
  {
    name: "buy_domain",
    description:
      "Create a Stripe CHECKOUT LINK for a domain — this does NOT buy it. Returns {checkout_url, domain, years, price, currency, expires_at}: give checkout_url to the USER, who pays it themselves. Only after they pay does Kleap register the domain (and connect it to app_id if given). NEVER tell the user the domain is bought or live until check_domain confirms it. Needs domains:checkout (Full preset key).",
    inputSchema: obj(
      {
        domain: str("The domain to buy, e.g. 'mybakery.com' (from search_domains)."),
        years: num("Registration years (default 1)."),
        app_id: num("Optional app id to connect the domain to once paid."),
      },
      ["domain"],
    ),
    handler: async ({ domain, years, app_id }) =>
      api("POST", "/domains/checkout", {
        domain: String(domain).trim().toLowerCase(),
        ...(years ? { years: Number(years) } : {}),
        ...(app_id != null && app_id !== "" ? { app_id: await toAppId(app_id) } : {}),
      }),
  },
  {
    name: "check_domain",
    description:
      "A domain's connection / DNS status on Kleap: active (serving, TLS provisioning), pending_dns (A record not set yet — relay the message), aaaa_conflict (remove the AAAA record). Also use it after a buy_domain checkout to see if the paid domain is registered.",
    inputSchema: obj({ domain: str("The domain, e.g. 'mybakery.com'.") }, ["domain"]),
    handler: ({ domain }) => api("GET", `/domains/${encodeURIComponent(String(domain).trim())}/check`),
  },
  {
    name: "connect_domain",
    description:
      "Connect a domain the user ALREADY OWNS to a live Kleap app (routing + automatic TLS). A completed create_app/modify_app already counts as live. The response's dns_config lists the exact A records to set at the registrar — relay them. Paid plan required (403 PLAN_REQUIRED otherwise). Does not buy anything.",
    inputSchema: obj({ app_id: APP_ID, domain: str("The domain, e.g. 'mybakery.com'.") }, ["app_id", "domain"]),
    handler: async ({ app_id, domain }) =>
      api("POST", "/domains/connect", { app_id: await toAppId(app_id), domain: String(domain).trim() }),
  },
  // ── Database ──────────────────────────────────────────────────────────────
  {
    name: "get_database_schema",
    description:
      "The app's Postgres database (Kleap Database): tables with row_count and columns {name, type, nullable, default, primary_key}. 409 DATABASE_NOT_PROVISIONED means the app has no database yet — ask modify_app to 'add a database' first. Needs database:read.",
    inputSchema: obj({ app_id: APP_ID }, ["app_id"]),
    handler: async ({ app_id }) => api("GET", `/apps/${await toAppId(app_id)}/database`),
  },
  {
    name: "query_database_rows",
    description:
      "Read rows of one table. where = equality filter object ({\"status\":\"new\"}); limit ≤500; page with offset while has_more. Returns {table, rows, limit, offset, has_more}.",
    inputSchema: obj(
      {
        app_id: APP_ID,
        table: str("Table name (from get_database_schema)."),
        where: anyObj("Optional equality filters, e.g. {\"status\":\"new\"}."),
        limit: num("Max rows, ≤500 (default server-side)."),
        offset: num("Offset for paging."),
        order_by: str("Column to sort by, e.g. created_at."),
        order: { type: "string", enum: ["asc", "desc"], description: "Sort direction." },
      },
      ["app_id", "table"],
    ),
    handler: async ({ app_id, table, where, limit, offset, order_by, order }) =>
      api(
        "GET",
        `${rowsPath(await toAppId(app_id), table)}${qs({
          limit,
          offset,
          order_by,
          order,
          where: where && Object.keys(where).length ? where : undefined,
        })}`,
      ),
  },
  {
    name: "insert_database_rows",
    description:
      "Insert rows (≤500 per call) into a table. Returns {table, inserted, rows} (rows = RETURNING *). Needs database:write.",
    inputSchema: obj(
      {
        app_id: APP_ID,
        table: str("Table name."),
        rows: { type: "array", items: { type: "object", additionalProperties: true }, description: "Row objects to insert." },
      },
      ["app_id", "table", "rows"],
    ),
    handler: async ({ app_id, table, rows }) =>
      api("POST", rowsPath(await toAppId(app_id), table), { rows: Array.isArray(rows) ? rows : [rows] }),
  },
  {
    name: "update_database_rows",
    description:
      "Update the rows matching `where` (equality filters, REQUIRED and non-empty) with the values in `set`. Returns {table, updated, rows}. Needs database:write.",
    inputSchema: obj(
      {
        app_id: APP_ID,
        table: str("Table name."),
        where: anyObj("Equality filters selecting the rows, e.g. {\"id\": 12}. Required, non-empty."),
        set: anyObj("Column values to set, e.g. {\"status\":\"done\"}."),
      },
      ["app_id", "table", "where", "set"],
    ),
    handler: async ({ app_id, table, where, set }) => {
      requireWhere(where, "update_database_rows");
      return api("PATCH", rowsPath(await toAppId(app_id), table), { where, set });
    },
  },
  {
    name: "delete_database_rows",
    description:
      "Delete the rows matching `where` (equality filters, REQUIRED and non-empty). Returns {table, deleted}. Irreversible — read the rows first. Needs database:write.",
    inputSchema: obj(
      { app_id: APP_ID, table: str("Table name."), where: anyObj("Equality filters, required, non-empty.") },
      ["app_id", "table", "where"],
    ),
    handler: async ({ app_id, table, where }) => {
      requireWhere(where, "delete_database_rows");
      return api("DELETE", rowsPath(await toAppId(app_id), table), { where });
    },
  },
  {
    name: "run_database_sql",
    description:
      "Run one SQL statement on the app's database with $1..$n params. A single SELECT needs database:read; anything else database:write. After DDL, a public table without row level security is refused with 422 RLS_REQUIRED — include ALTER TABLE … ENABLE ROW LEVEL SECURITY. Returns {command, row_count, rows}.",
    inputSchema: obj(
      {
        app_id: APP_ID,
        sql: str("The SQL statement."),
        params: { type: "array", items: {}, description: "Optional positional parameters for $1, $2, …" },
      },
      ["app_id", "sql"],
    ),
    handler: async ({ app_id, sql, params }) =>
      api("POST", `/apps/${await toAppId(app_id)}/database/query`, {
        sql,
        ...(params != null ? { params: Array.isArray(params) ? params : [params] } : {}),
      }),
  },
];

const INSTRUCTIONS = `Kleap builds and HOSTS real websites (Astro). You have TWO ways to put code on a site — pick per task:
  • read_files → edit_files / write_files → publish_app (DETERMINISTIC): YOUR model writes the exact change; Kleap stores, builds and deploys it AS-IS. No Kleap credits, never stalls. Use edit_files for changes inside an existing file (send old_string/new_string), write_files for new files or wholesale replacement (encoding:"base64" for images/fonts), delete_files to remove a page or asset, generate_image to add a real generated picture without sending bytes. Then publish_app.
  • modify_app (Kleap's AI does it): describe the OUTCOME and Kleap's AI writes the files — best for design, whole sections, adding a database/auth.
Either way KLEAP HOSTS the result — build, deploy, SSL, database, auth, forms, custom domains, and the verified-live guarantee.

THE LOOP
1. Find the site: find_app for a domain/URL/slug the user names; else list_apps (supports q).
2. Build or change it. create_app / modify_app return a task_id — call check_task (it long-polls up to 50 s) again while status is queued/processing; a full build is ~1-15 min, so many check_task calls in a row are NORMAL. When status="completed" the change is already LIVE (they auto-deploy).
3. After write_files / edit_files / delete_files / generate_image, call publish_app, then get_publish_status (pass its deploy_key) until status="published". Its report lists broken links and SEO coverage — read it.

GOLDEN RULE: never tell the user a site is live until check_task says completed or get_publish_status says published with a production_url.

ON FAILURE (check_task status="failed"): TASK_TIMEOUT / STALE_TASK → retry_task (NEW task_id; up to twice). TASK_FAILED → retry_task once, then stop and tell the user.

AFTER PUBLISH: get_form_submissions = the site's leads (newest first; since= for only new ones). get_analytics = visitors/pageviews. get_search_console = Google search performance (if not connected, connect_search_console returns a consent_url for the USER to open).

DATABASE (the app's Postgres): get_database_schema → query_database_rows / insert_database_rows / update_database_rows / delete_database_rows (where is REQUIRED for update/delete) or run_database_sql. 409 DATABASE_NOT_PROVISIONED → modify_app(app_id, "add a database") first. 422 RLS_REQUIRED → enable row level security in the same SQL.

DOMAINS: search_domains → buy_domain returns a Stripe checkout_url that the USER must open and pay — it is NOT bought until they pay; confirm afterwards with check_domain. Never say "bought" or "live" before that. connect_domain attaches a domain the user already owns (paid plan) and returns the A records to relay.

ERRORS carry error.code: 402 INSUFFICIENT_CREDITS (get_credits, ask the user to top up — do NOT retry), 403 INSUFFICIENT_SCOPE (the key lacks the scope in details.required_scope — the user must create a new API key with the Full preset), 403 PLAN_REQUIRED (paid plan needed), 429 RATE_LIMITED (back off, honor Retry-After), 400 VALIDATION_ERROR (fix the input), 404 NOT_FOUND (wrong id — use find_app), 409 CONFLICT on publish (a deploy is already running; publish_app follows it for you).

rename_app changes only the display name — the URL never changes. There is no delete-app tool, by design.`;

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
    const extra = [
      e?.hint ? `Hint: ${e.hint}` : "",
      e?.details ? `Details: ${JSON.stringify(e.details)}` : "",
      e?.request_id ? `(request ${e.request_id})` : "",
    ].filter(Boolean);
    return {
      isError: true,
      content: [{ type: "text", text: [`Error: ${e?.message || e}`, ...extra].join("\n") }],
    };
  }
});

// ── CLI dispatch ────────────────────────────────────────────────────────────
// Recognized subcommands run and exit with a compact, agent-friendly result
// (1-3 lines, clean exit codes, optional --json). No args — or `kleap mcp` —
// starts the stdio MCP server instead; that's what MCP clients expect, and is
// the unchanged, backward-compatible default.
const CLI_COMMANDS = [
  "create",
  "edit",
  "publish",
  "status",
  "list",
  "domains",
  "screenshot",
  "files",
  "forms",
  "analytics",
  "db",
  "task",
  "rename",
  "wake",
  "image",
  "search-console",
  "credits",
  "messages",
];
const TOP_LEVEL_COMMANDS = [
  "auth",
  ...CLI_COMMANDS,
  "mcp",
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
];
const cmd = process.argv.slice(2);

// Print, THEN exit once stdout has flushed. A bare process.exit() right after
// a large write can truncate piped output (stdout pipes are async on macOS),
// which would hand an agent half a JSON document. Returns a never-settling
// promise so `return emitOk(...)` halts the caller until the exit happens.
function finish(text, code = 0) {
  process.stdout.write(`${text}\n`, () => process.exit(code));
  return new Promise(() => {});
}
function emitOk(line, data, json) {
  return finish(json ? JSON.stringify(data ?? {}) : line, 0);
}
// EVERY CLI error must exit through here so `--json` is honored on ALL paths
// (API errors, usage errors, auth guards, unknown commands) — an agent that
// JSON.parses the output must never receive bare prose. Convention (same as
// emitOk): JSON on stdout, plain-text `✗ ...` on stderr; exit code 1 either way.
function emitErr(message, json, code, extra = {}) {
  if (json) {
    const error = { ...(code ? { code } : {}), message };
    for (const k of ["status", "details", "request_id", "hint"]) {
      if (extra[k] !== undefined) error[k] = extra[k];
    }
    if (extra.task) error.task = extra.task;
    console.log(JSON.stringify({ error }));
  } else {
    console.error(`✗ ${message}${extra.hint ? `\n  → ${extra.hint}` : ""}`);
  }
  process.exit(1);
}
function usage(text) {
  const err = new Error(`usage: ${text}`);
  err.code = "usage";
  return err;
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
// Auth + resolve in one step for every `<app>` command.
async function appFrom(appArg, usageText) {
  if (!appArg) throw usage(usageText);
  await ensureToken();
  return resolveAppId(appArg);
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
      { timeoutMs: 75000 },
    );
    if (task.status === "completed" || task.status === "failed") return task;
  } while (Date.now() - start < maxWaitMs);
  throw new Error(
    `task ${taskId} still ${task.status} after ${Math.round(maxWaitMs / 60000)}min — check again later: kleap task ${taskId} --wait`,
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
function taskFailure(task, verb) {
  const err = new Error(
    `${verb} failed [${task.error?.code || "TASK_FAILED"}]: ${task.error?.message || "unknown error"} — resume it: kleap task retry ${task.task_id}`,
  );
  err.code = task.error?.code || "TASK_FAILED";
  err.task = task;
  return err;
}
// Read all of stdin as a Buffer (for `files write --stdin`).
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks);
}

async function cliCreate(positional, flags) {
  const prompt = positional.join(" ").trim();
  if (!prompt) {
    throw usage('kleap create "<prompt>" [--visibility public|personal] [--webhook <url>] [--no-wait] [--json]');
  }
  await ensureToken();
  const created = await api("POST", "/apps", {
    prompt,
    visibility: flags.visibility || "personal",
    ...(flags.webhook ? { webhook_url: flags.webhook } : {}),
    metadata: SOURCE_METADATA,
  });
  if (flags.noWait) {
    return emitOk(
      `… creating app ${created.app_id} (task ${created.task_id}) — kleap task ${created.task_id} --wait`,
      created,
      flags.json,
    );
  }
  const task = await pollTask(created.task_id);
  if (task.status === "failed") throw taskFailure({ task_id: created.task_id, ...task }, "create");
  const url = await resolveLiveUrl(created.app_id, task);
  return emitOk(
    `✓ created app ${created.app_id} — ${url || `(built, deploy pending — kleap status ${created.app_id})`}`,
    { app_id: created.app_id, task_id: created.task_id, url, task },
    flags.json,
  );
}

async function cliEdit(positional, flags) {
  const [appArg, ...rest] = positional;
  const prompt = rest.join(" ").trim();
  const u = 'kleap edit <app> "<prompt>" [--webhook <url>] [--no-wait] [--json]';
  if (!appArg || !prompt) throw usage(u);
  const appId = await appFrom(appArg, u);
  const created = await api("POST", `/apps/${appId}/messages`, {
    message: prompt,
    ...(flags.webhook ? { webhook_url: flags.webhook } : {}),
    metadata: SOURCE_METADATA,
  });
  if (flags.noWait) {
    return emitOk(
      `… editing app ${appId} (task ${created.task_id}) — kleap task ${created.task_id} --wait`,
      { app_id: appId, ...created },
      flags.json,
    );
  }
  const task = await pollTask(created.task_id);
  if (task.status === "failed") throw taskFailure({ task_id: created.task_id, ...task }, "edit");
  const url = await resolveLiveUrl(appId, task);
  return emitOk(
    `✓ edited app ${appId} — ${url || `(built, deploy pending — kleap status ${appId})`}`,
    { app_id: appId, task_id: created.task_id, url, task },
    flags.json,
  );
}

async function cliPublish(positional, flags) {
  const appId = await appFrom(positional[0], "kleap publish <app> [--no-wait] [--json]");
  const started = await startPublish(appId);
  if (flags.noWait) {
    return emitOk(
      `… publishing app ${appId}${started.already_running ? " (a deploy was already running)" : ""} — kleap status ${appId}`,
      started,
      flags.json,
    );
  }
  const deployKey = started.deploy_key;
  const start = Date.now();
  let last = started;
  while (Date.now() - start < 10 * 60 * 1000) {
    last = await api(
      "GET",
      `/apps/${appId}/publish${qs({ deploy_key: deployKey, wait: 30 })}`,
      undefined,
      { timeoutMs: 60000 },
    );
    if (last.status === "published") {
      return emitOk(`✓ published ${last.production_url}`, { app_id: appId, ...last }, flags.json);
    }
    if (last.status === "failed" || last.status === "error") {
      const err = new Error(`publish failed: ${last.message || last.error?.message || last.status} — the previous version stays live`);
      err.code = last.error?.code || "PUBLISH_FAILED";
      throw err;
    }
    await sleep(2000);
  }
  throw new Error(`not confirmed live after 10min (status: ${last.status}) — recheck: kleap status ${appId}`);
}

async function cliStatus(positional, flags) {
  const appId = await appFrom(positional[0], "kleap status <app> [--json]");
  const app = await api("GET", `/apps/${appId}`);
  return emitOk(`✓ ${formatAppLine(app)}`, app, flags.json);
}

async function cliList(positional, flags) {
  await ensureToken();
  const res = await api("GET", `/apps${qs({ limit: flags.limit, offset: flags.offset, q: flags.q })}`);
  if (flags.json) return finish(JSON.stringify(res));
  const apps = res.apps || [];
  if (!apps.length) return finish("(no apps)");
  const lines = apps.map(formatListLine);
  if (res.pagination?.has_more) lines.push(`… ${res.pagination.total} apps total — next page: --offset ${res.pagination.next_offset}`);
  return finish(lines.join("\n"));
}

async function cliScreenshot(positional, flags) {
  const appId = await appFrom(positional[0], "kleap screenshot <app> [--json]");
  const res = await api("GET", `/apps/${appId}/screenshot`);
  return emitOk(`✓ ${res.image_url}`, res, flags.json);
}

async function cliRename(positional, flags) {
  const [appArg, ...rest] = positional;
  const name = rest.join(" ").trim();
  const u = "kleap rename <app> <new name> [--json]";
  if (!name) throw usage(u);
  const appId = await appFrom(appArg, u);
  const res = await api("PATCH", `/apps/${appId}`, { name });
  return emitOk(`✓ renamed app ${appId} to "${res?.name || name}" (URL unchanged)`, res, flags.json);
}

async function cliWake(positional, flags) {
  const appId = await appFrom(positional[0], "kleap wake <app> [--json]");
  const res = await api("POST", `/apps/${appId}/wake`, {});
  return emitOk(
    `✓ ${res?.message || `app ${appId} waking up`}${res?.preview_url ? ` — ${res.preview_url}` : ""}`,
    res,
    flags.json,
  );
}

async function cliImage(positional, flags) {
  const [appArg, path, ...rest] = positional;
  const prompt = rest.join(" ").trim();
  const u = 'kleap image <app> <public/name.webp> "<prompt>" [--hd] [--width N --height N] [--json]';
  if (!appArg || !path || !prompt) throw usage(u);
  if (!/^public\/.+\.(png|jpe?g|webp)$/i.test(path)) {
    throw usage(`${u}\n  the path must start with public/ and end in .png, .jpg, .jpeg or .webp`);
  }
  const appId = await appFrom(appArg, u);
  const res = await api(
    "POST",
    `/apps/${appId}/generate-image`,
    {
      path,
      prompt,
      ...(flags.hd ? { hd: true } : {}),
      ...(flags.width ? { width: Number(flags.width) } : {}),
      ...(flags.height ? { height: Number(flags.height) } : {}),
    },
    { timeoutMs: 180000, retries: 0 },
  );
  const kb = res?.bytes ? ` (${Math.round(res.bytes / 1024)} KB)` : "";
  return emitOk(`✓ generated ${res?.path || path}${kb} — deploy it: kleap publish ${appId}`, res, flags.json);
}

async function cliCredits(positional, flags) {
  await ensureToken();
  const res = await api("GET", "/account/credits");
  return emitOk(
    `✓ ${res.credits_balance} credits — ${res.is_paid ? "paid plan" : "free plan"}`,
    res,
    flags.json,
  );
}

async function cliMessages(positional, flags) {
  const appId = await appFrom(positional[0], "kleap messages <app> [--limit N] [--json]");
  const res = await api("GET", `/apps/${appId}/messages${qs({ limit: flags.limit || 20 })}`);
  if (flags.json) return finish(JSON.stringify(res));
  const msgs = res.messages || [];
  if (!msgs.length) return finish("(no messages)");
  return finish(msgs.map(formatMessageLine).join("\n"));
}

async function cliForms(positional, flags) {
  const appId = await appFrom(positional[0], "kleap forms <app> [--since ISO] [--limit N] [--json]");
  let since;
  if (flags.since) {
    const d = new Date(flags.since);
    if (Number.isNaN(d.getTime())) throw usage("kleap forms <app> --since <ISO 8601 date, e.g. 2026-09-01T00:00:00Z>");
    since = d.toISOString();
  }
  const res = await api("GET", `/apps/${appId}/forms${qs({ limit: flags.limit || 20, since })}`);
  const subs = res.submissions || [];
  if (flags.json) {
    return finish(JSON.stringify({ app_id: appId, count: subs.length, submissions: subs.map((s) => flattenSubmission(s, appId)) }));
  }
  if (!subs.length) return finish("(no form submissions)");
  return finish(subs.map(formatSubmissionLine).join("\n"));
}

async function cliAnalytics(positional, flags) {
  const u = "kleap analytics <app> [--period 7d|30d|90d] [--json]";
  if (flags.period && !["7d", "30d", "90d"].includes(flags.period)) throw usage(u);
  const appId = await appFrom(positional[0], u);
  const res = await api("GET", `/apps/${appId}/analytics${qs({ period: flags.period })}`);
  return emitOk(`✓ ${formatAnalytics(res)}`, res, flags.json);
}

async function cliSearchConsole(positional, flags) {
  if (positional[0] === "connect") {
    const appId = await appFrom(positional[1], "kleap search-console connect <app> [--json]");
    const res = await api("POST", `/apps/${appId}/search-console/connect`, {});
    let line;
    if (res.consent_url) {
      line = `→ the user must open this link and approve Google access (${res.custom_domain || "their domain"}): ${res.consent_url}`;
    } else if (res.site_selected) {
      line = `✓ Search Console already connected (${res.site_url || res.custom_domain}) — kleap search-console ${appId}`;
    } else {
      line = `✗ ${res.message || "cannot connect yet"}`;
    }
    return emitOk(line, res, flags.json);
  }
  const appId = await appFrom(positional[0], "kleap search-console <app> | kleap search-console connect <app> [--json]");
  const res = await api("GET", `/apps/${appId}/search-console`);
  return emitOk(`✓ ${formatSearchConsole(res)}`, res, flags.json);
}

// ── task ────────────────────────────────────────────────────────────────────
function taskLine(task) {
  if (task.status === "completed") {
    const url = task.result?.production_url || task.result?.preview_url;
    return `✓ task ${task.task_id} completed — app ${task.app_id ?? "?"}${url ? ` ${url}` : ""}`;
  }
  return `… task ${task.task_id} ${task.status}${task.app_id ? ` (app ${task.app_id})` : ""} — kleap task ${task.task_id} --wait`;
}
async function cliTask(positional, flags) {
  if (positional[0] === "retry") {
    const u = "kleap task retry <task_id> [--wait] [--json]";
    if (!positional[1]) throw usage(u);
    await ensureToken();
    const retried = await api("POST", `/tasks/${encodeURIComponent(positional[1])}/retry`, {});
    if (!flags.wait) {
      return emitOk(`… retrying as task ${retried.task_id} — kleap task ${retried.task_id} --wait`, retried, flags.json);
    }
    const task = await pollTask(retried.task_id);
    if (task.status === "failed") throw taskFailure({ task_id: retried.task_id, ...task }, "retry");
    return emitOk(taskLine({ task_id: retried.task_id, ...task }), { ...retried, ...task }, flags.json);
  }
  const taskId = positional[0];
  if (!taskId) throw usage("kleap task <task_id> [--wait] [--json] | kleap task retry <task_id> [--wait]");
  await ensureToken();
  const task = flags.wait
    ? await pollTask(taskId)
    : await api("GET", `/tasks/${encodeURIComponent(taskId)}?wait=0`);
  const full = { task_id: taskId, ...task };
  if (full.status === "failed") throw taskFailure(full, `task ${taskId}`);
  return emitOk(taskLine(full), full, flags.json);
}

// ── files ───────────────────────────────────────────────────────────────────
const MAX_FILE_BYTES = 512 * 1024;
async function cliFiles(positional, flags) {
  const [sub, appArg, ...rest] = positional;
  const U = {
    ls: "kleap files ls <app> [--json]",
    cat: "kleap files cat <app> <path...> [--json]",
    write: 'kleap files write <app> <path> --file <local> | --stdin | --content "<text>" [--json]',
    edit: 'kleap files edit <app> <path> --find "<old>" --replace "<new>" [--all] [--json]',
    rm: "kleap files rm <app> <path...> [--json]",
  };
  if (!U[sub]) throw usage("kleap files <ls|cat|write|edit|rm> <app> ...");

  if (sub === "ls") {
    const appId = await appFrom(appArg, U.ls);
    const res = await api("GET", `/apps/${appId}/files`);
    if (flags.json) return finish(JSON.stringify(res));
    const files = res.files || [];
    if (!files.length) return finish("(no files)");
    return finish(files.map((f) => f.path).join("\n"));
  }

  if (sub === "cat") {
    if (!rest.length) throw usage(U.cat);
    const appId = await appFrom(appArg, U.cat);
    const files = [];
    const missing = [];
    for (let i = 0; i < rest.length; i += 60) {
      const res = await api("GET", `/apps/${appId}/files?paths=${encodeURIComponent(rest.slice(i, i + 60).join(","))}`);
      files.push(...(res.files || []));
      missing.push(...(res.missing || []));
    }
    if (flags.json) {
      if (missing.length && !files.length) {
        return emitErr(`not found: ${missing.join(", ")}`, true, "NOT_FOUND", { details: { missing } });
      }
      return finish(JSON.stringify({ files, missing }));
    }
    const show = (f) =>
      f.type === "binary" || f.encoding === "base64"
        ? `(binary file, ${f.bytes ?? "?"} bytes — use --json to get it base64)`
        : String(f.content ?? "").replace(/\n$/, "");
    const out =
      files.length === 1 && rest.length === 1
        ? show(files[0])
        : files.map((f) => `==> ${f.path} <==\n${show(f)}`).join("\n\n");
    if (missing.length) {
      if (out) process.stdout.write(`${out}\n`);
      return emitErr(`not found: ${missing.join(", ")}`, false, "NOT_FOUND");
    }
    return finish(out);
  }

  if (sub === "write") {
    const [path] = rest;
    if (!path) throw usage(U.write);
    const sources = [flags.file !== undefined, !!flags.stdin, flags.content !== undefined].filter(Boolean).length;
    if (sources !== 1) throw usage(`${U.write}\n  pass exactly one of --file, --stdin, --content`);
    let buf;
    if (flags.file !== undefined) {
      try {
        buf = readFileSync(flags.file);
      } catch (e) {
        const err = new Error(`cannot read ${flags.file}: ${e.code || e.message}`);
        err.code = "usage";
        throw err;
      }
    } else if (flags.stdin) {
      buf = await readStdin();
    } else {
      buf = Buffer.from(flags.content, "utf8");
    }
    if (buf.length > MAX_FILE_BYTES) {
      const err = new Error(`${path} is ${Math.round(buf.length / 1024)} KB — the API accepts at most 512 KB per file`);
      err.code = "FILE_TOO_LARGE";
      throw err;
    }
    const binary = isBinaryPath(path);
    const file = binary
      ? { path, content: buf.toString("base64"), encoding: "base64" }
      : { path, content: buf.toString("utf8") };
    const appId = await appFrom(appArg, U.write);
    const res = await api("PUT", `/apps/${appId}/files`, { files: [file] });
    return emitOk(
      `✓ wrote ${path} (${buf.length} bytes${binary ? ", base64" : ""}) to app ${appId} — deploy it: kleap publish ${appId}`,
      res,
      flags.json,
    );
  }

  if (sub === "edit") {
    const [path] = rest;
    if (!path || flags.find === undefined || flags.find === "" || flags.replace === undefined) throw usage(U.edit);
    const appId = await appFrom(appArg, U.edit);
    const res = await api("PATCH", `/apps/${appId}/files`, {
      edits: [{ path, old_string: flags.find, new_string: flags.replace, ...(flags.all ? { replace_all: true } : {}) }],
    });
    const n = res?.replacements ?? res?.edited?.[0]?.replacements;
    return emitOk(
      `✓ edited ${path}${n != null ? ` (${n} replacement${n === 1 ? "" : "s"})` : ""} in app ${appId} — deploy it: kleap publish ${appId}`,
      res,
      flags.json,
    );
  }

  // rm
  if (!rest.length) throw usage(U.rm);
  const appId = await appFrom(appArg, U.rm);
  const res = await api("DELETE", `/apps/${appId}/files`, { paths: rest });
  const deleted = res?.deleted || [];
  const line = deleted.length
    ? `✓ deleted ${deleted.join(", ")} from app ${appId} — the pages stay live until: kleap publish ${appId}`
    : `✓ nothing deleted — none of those paths exist on app ${appId}`;
  return emitOk(line, res, flags.json);
}

// ── db ──────────────────────────────────────────────────────────────────────
async function cliDb(positional, flags) {
  const [sub, appArg, ...rest] = positional;
  const U = {
    schema: "kleap db schema <app> [--json]",
    rows: "kleap db rows <app> <table> [--where json] [--limit N] [--offset N] [--order-by col --order asc|desc] [--json]",
    insert: "kleap db insert <app> <table> '<json object|array>' | --file rows.json [--json]",
    update: "kleap db update <app> <table> --where json --set json [--json]",
    delete: "kleap db delete <app> <table> --where json [--json]",
    sql: 'kleap db sql <app> "<sql>" [--params json] [--json]',
  };
  if (!U[sub]) throw usage("kleap db <schema|rows|insert|update|delete|sql> <app> ...");

  if (sub === "schema") {
    const appId = await appFrom(appArg, U.schema);
    const res = await api("GET", `/apps/${appId}/database`);
    if (flags.json) return finish(JSON.stringify(res));
    const tables = res.tables || [];
    if (!tables.length) return finish("(database provisioned, no tables yet)");
    return finish(tables.map(formatTableLine).join("\n"));
  }

  if (sub === "sql") {
    const sql = rest.join(" ").trim();
    if (!sql) throw usage(U.sql);
    const params = parseJsonArg(flags.params, "--params");
    const appId = await appFrom(appArg, U.sql);
    const res = await api("POST", `/apps/${appId}/database/query`, {
      sql,
      ...(params !== undefined ? { params: Array.isArray(params) ? params : [params] } : {}),
    });
    if (flags.json) return finish(JSON.stringify(res));
    const lines = (res.rows || []).map((r) => JSON.stringify(r));
    lines.push(`✓ ${res.command || "OK"} — ${res.row_count ?? (res.rows || []).length} row(s)`);
    return finish(lines.join("\n"));
  }

  const [table, ...more] = rest;
  if (!table) throw usage(U[sub]);

  if (sub === "rows") {
    const where = parseJsonArg(flags.where, "--where");
    if (flags.order && !["asc", "desc"].includes(flags.order)) throw usage(U.rows);
    const appId = await appFrom(appArg, U.rows);
    const res = await api(
      "GET",
      `${rowsPath(appId, table)}${qs({
        limit: flags.limit,
        offset: flags.offset,
        order_by: flags.orderBy,
        order: flags.order,
        where: where && Object.keys(where).length ? where : undefined,
      })}`,
    );
    if (flags.json) return finish(JSON.stringify(res));
    const rows = res.rows || [];
    if (!rows.length) return finish("(no rows)");
    const lines = rows.map((r) => JSON.stringify(r));
    if (res.has_more) lines.push(`… more rows — next page: --offset ${(res.offset || 0) + rows.length}`);
    return finish(lines.join("\n"));
  }

  if (sub === "insert") {
    let raw = more.join(" ").trim();
    if (flags.file !== undefined) {
      try {
        raw = readFileSync(flags.file, "utf8");
      } catch (e) {
        const err = new Error(`cannot read ${flags.file}: ${e.code || e.message}`);
        err.code = "usage";
        throw err;
      }
    }
    if (!raw) throw usage(U.insert);
    const parsed = parseJsonArg(raw, "rows");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    if (!rows.length || rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
      throw usage(`${U.insert}\n  rows must be a JSON object or an array of objects`);
    }
    const appId = await appFrom(appArg, U.insert);
    let inserted = 0;
    const returned = [];
    for (let i = 0; i < rows.length; i += 500) {
      const res = await api("POST", rowsPath(appId, table), { rows: rows.slice(i, i + 500) });
      inserted += res.inserted ?? (res.rows || []).length;
      returned.push(...(res.rows || []));
    }
    return emitOk(`✓ inserted ${inserted} row(s) into ${table}`, { table, inserted, rows: returned }, flags.json);
  }

  const where = parseJsonArg(flags.where, "--where");
  requireWhere(where, `kleap db ${sub}`);

  if (sub === "update") {
    const set = parseJsonArg(flags.set, "--set");
    if (!set || typeof set !== "object" || Array.isArray(set) || !Object.keys(set).length) throw usage(U.update);
    const appId = await appFrom(appArg, U.update);
    const res = await api("PATCH", rowsPath(appId, table), { where, set });
    return emitOk(`✓ updated ${res.updated ?? (res.rows || []).length} row(s) in ${table}`, res, flags.json);
  }

  // delete
  const appId = await appFrom(appArg, U.delete);
  const res = await api("DELETE", rowsPath(appId, table), { where });
  return emitOk(`✓ deleted ${res.deleted ?? 0} row(s) from ${table}`, res, flags.json);
}

// ── domains ─────────────────────────────────────────────────────────────────
async function cliDomainsSearch(positional, flags) {
  const query = normalizeDomainQuery(positional.join(" "));
  if (!query) throw usage("kleap domains search <name> [--tlds .com,.io] [--json]");
  await ensureToken();
  const tlds = normalizeTlds(flags.tlds);
  const res = await api("POST", "/domains/search", { query, ...(tlds ? { tlds } : {}) });
  if (flags.json) return finish(JSON.stringify(res));
  const available = (res.results || []).filter((r) => r.status === "free");
  if (!available.length) return finish("(no available domains found)");
  return finish(available.map(formatDomainLine).join("\n"));
}

async function cliDomainsBuy(positional, flags) {
  const domain = String(positional[0] || "").trim().toLowerCase();
  const u = "kleap domains buy <domain> [--years N] [--app <app>] [--json]";
  if (!domain || !domain.includes(".")) throw usage(u);
  if (flags.years !== undefined && !/^\d+$/.test(String(flags.years))) throw usage(u);
  await ensureToken();
  const appId = flags.app ? await resolveAppId(flags.app) : undefined;
  const res = await api("POST", "/domains/checkout", {
    domain,
    ...(flags.years ? { years: Number(flags.years) } : {}),
    ...(appId ? { app_id: appId } : {}),
  });
  const price = res.price != null ? `${res.price}${res.currency ? " " + res.currency : ""}, ` : "";
  const yrs = res.years ?? (Number(flags.years) || 1);
  const lines = [
    `→ checkout for ${res.domain || domain} (${price}${yrs} year${yrs === 1 ? "" : "s"}): ${res.checkout_url}`,
    `  NOT bought yet — the user must open this link and pay.${appId ? ` Once paid it is registered and connected to app ${appId}.` : " Once paid it is registered."} Then: kleap domains check ${res.domain || domain}`,
  ];
  return emitOk(lines.join("\n"), { ...res, paid: false, requires_user_payment: true }, flags.json);
}

async function cliDomainsCheck(positional, flags) {
  const domain = String(positional[0] || "").trim();
  if (!domain) throw usage("kleap domains check <domain> [--json]");
  await ensureToken();
  const res = await api("GET", `/domains/${encodeURIComponent(domain)}/check`);
  let line;
  if (res.status === "active") line = `✓ ${res.domain || domain} active — ${res.url || `https://${domain}`}${res.tls ? ` (TLS ${res.tls})` : ""}`;
  else if (res.status === "pending_dns") line = `… ${res.domain || domain} pending DNS — ${res.message || "A record not set yet"}`;
  else line = `${res.status === "aaaa_conflict" ? "✗" : "…"} ${res.domain || domain} ${res.status}${res.message ? ` — ${res.message}` : ""}`;
  return emitOk(line, res, flags.json);
}

async function cliDomainsConnect(positional, flags) {
  const [domain, appArg] = positional;
  const u = "kleap domains connect <domain> <app> [--json]";
  if (!domain || !appArg) throw usage(u);
  const appId = await appFrom(appArg, u);
  const res = await api("POST", "/domains/connect", { app_id: appId, domain });
  if (flags.json) return finish(JSON.stringify(res));
  const ip = findApexARecord(res.dns_config);
  return finish(`✓ ${domain} pending DNS — point A @ to ${ip || "(see --json)"}, propagation 5-60min`);
}

async function cliDomains(positional, flags) {
  const [sub, ...rest] = positional;
  if (sub === "search") return cliDomainsSearch(rest, flags);
  if (sub === "buy") return cliDomainsBuy(rest, flags);
  if (sub === "check") return cliDomainsCheck(rest, flags);
  if (sub === "connect") return cliDomainsConnect(rest, flags);
  throw usage("kleap domains <search|buy|check|connect> ...");
}

const CLI_HANDLERS = {
  create: cliCreate,
  edit: cliEdit,
  publish: cliPublish,
  status: cliStatus,
  list: cliList,
  screenshot: cliScreenshot,
  domains: cliDomains,
  files: cliFiles,
  forms: cliForms,
  analytics: cliAnalytics,
  db: cliDb,
  task: cliTask,
  rename: cliRename,
  wake: cliWake,
  image: cliImage,
  "search-console": cliSearchConsole,
  credits: cliCredits,
  messages: cliMessages,
};

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

if (CLI_HANDLERS[cmd[0]]) {
  const [, ...rest] = cmd;
  const { positional, flags } = parseArgs(rest);
  try {
    await CLI_HANDLERS[cmd[0]](positional, flags);
  } catch (e) {
    emitErr(e?.message || String(e), flags.json, e?.code, {
      status: e?.status,
      details: e?.details,
      request_id: e?.request_id,
      hint: e?.hint,
      task: e?.task,
    });
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
    "[kleap-mcp] Not signed in. Run `npx -y kleap-cli auth login` (opens your browser, no API key needed),\n" +
      "             or set KLEAP_API_KEY=kleap_live_sk_... (https://kleap.co/settings/api-key).",
  );
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[kleap-mcp] ready (stdio) → ${API_URL}. Tools: ${TOOLS.map((t) => t.name).join(", ")}`,
);
