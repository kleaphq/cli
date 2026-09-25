// Pure, dependency-free helpers shared by the CLI dispatch (kleap-mcp-server.mjs)
// and the unit tests. No I/O, no process.exit, no network — safe to import
// anywhere without side effects.

// Flags that take NO value. key = argv spelling, value = flags.<name>.
const BOOL_FLAGS = {
  "--json": "json",
  "--no-wait": "noWait",
  "--wait": "wait",
  "--all": "all",
  "--stdin": "stdin",
  "--hd": "hd",
};
// Flags that consume the NEXT argv entry (or `--flag=value`).
const VALUE_FLAGS = {
  "--visibility": "visibility",
  "--webhook": "webhook",
  "--limit": "limit",
  "--offset": "offset",
  "--q": "q",
  "--query": "q",
  "--tlds": "tlds",
  "--since": "since",
  "--period": "period",
  "--where": "where",
  "--set": "set",
  "--params": "params",
  "--file": "file",
  "--content": "content",
  "--find": "find",
  "--replace": "replace",
  "--years": "years",
  "--app": "app",
  "--order-by": "orderBy",
  "--order": "order",
  "--width": "width",
  "--height": "height",
};

/** Split argv into positional args + known --flags (agent-friendly, no lib). */
export function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (BOOL_FLAGS[a]) {
      flags[BOOL_FLAGS[a]] = true;
      continue;
    }
    if (VALUE_FLAGS[a]) {
      // A value flag given as the LAST argv entry has no value — record it
      // as "" rather than undefined so the command can report it properly.
      flags[VALUE_FLAGS[a]] = i + 1 < args.length ? args[++i] : "";
      continue;
    }
    const eq = typeof a === "string" && a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 2 && VALUE_FLAGS[a.slice(0, eq)]) {
      flags[VALUE_FLAGS[a.slice(0, eq)]] = a.slice(eq + 1);
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

/** True if the string is a bare numeric app id (vs. a slug/domain/URL). */
export function isNumericId(s) {
  return /^\d+$/.test(String(s ?? ""));
}

/** One-line summary for `kleap status`. */
export function formatAppLine(app) {
  const where = app.production_url
    ? `live: ${app.production_url}`
    : "not published";
  return `${app.name} (${app.id}) — ${where}`;
}

/** One tab-separated row per app for `kleap list`. */
export function formatListLine(app) {
  return `${app.id}\t${app.name}\t${app.production_url || "-"}`;
}

/** One tab-separated row per available domain for `kleap domains search`. */
export function formatDomainLine(r) {
  const price = r.price != null ? `${r.price}${r.currency ? " " + r.currency : ""}` : "";
  return `${r.domain}\t${price}`.trim();
}

/** Pull the apex A-record value out of a domains/connect `dns_config`. */
export function findApexARecord(dnsConfig) {
  const rec = (dnsConfig?.records || []).find(
    (r) => r.type === "A" && r.name === "@",
  );
  return rec?.value || null;
}

// ── 2.1.0 helpers ───────────────────────────────────────────────────────────

// Extensions whose bytes are not text: `files write` sends them base64 with
// encoding:"base64" (the API stores them as real binary assets). SVG is XML
// text and stays UTF-8 on purpose.
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tif", "tiff", "heic",
  "woff", "woff2", "ttf", "otf", "eot",
  "pdf", "zip", "gz", "tar",
  "mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "m4a", "flac",
  "glb", "gltf", "wasm", "bin",
]);

/** True when a path's extension means binary content (→ base64 upload). */
export function isBinaryPath(path) {
  const m = /\.([a-z0-9]+)$/i.exec(String(path || ""));
  return !!m && BINARY_EXTENSIONS.has(m[1].toLowerCase());
}

/**
 * Normalize a domain search query to the single label the API accepts:
 * "Café Lumière" → "cafelumiere". Mirrors the n8n reference node.
 */
export function normalizeDomainQuery(q) {
  return String(q || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "");
}

/** ".com,io , ch" → [".com", ".io", ".ch"] (leading dot added when missing). */
export function normalizeTlds(s) {
  if (!s) return undefined;
  const out = String(s)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith(".") ? t : `.${t}`));
  return out.length ? out : undefined;
}

/**
 * Flatten a form submission: the `data` fields at top level, plus
 * submission_id / submitted_at / app_id (the integrations contract shape).
 */
export function flattenSubmission(sub, appId) {
  return {
    ...(sub?.data || {}),
    submission_id: sub?.id,
    submitted_at: sub?.submitted_at,
    app_id: Number(appId),
  };
}

/** One line per submission: `<submitted_at>\tkey=value · key=value`. */
export function formatSubmissionLine(sub) {
  const fields = Object.entries(sub?.data || {})
    .map(([k, v]) => `${k}=${oneLine(typeof v === "string" ? v : JSON.stringify(v), 80)}`)
    .join(" · ");
  return `${sub?.submitted_at || "?"}\t${fields || "(empty)"}`;
}

/** Collapse whitespace and cut to `max` chars with an ellipsis. */
export function oneLine(s, max = 120) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** `kleap analytics` one-liner (+ the API's own message when not configured). */
export function formatAnalytics(a) {
  const top = (a?.top_pages || [])
    .slice(0, 3)
    .map((p) => `${p.path ?? p.page ?? p.url ?? "?"} (${p.pageviews ?? p.views ?? p.visitors ?? p.count ?? "?"})`)
    .join(", ");
  const head = `${a?.period || "?"}: ${a?.visitors ?? 0} visitors, ${a?.pageviews ?? 0} pageviews`;
  const line = top ? `${head} — top: ${top}` : head;
  return a?.configured === false && a?.message ? `${line}\n  ${a.message}` : line;
}

/** Footer line when the API capped the rows it returned. */
export function truncationNote(res) {
  return res?.truncated
    ? "… truncated by the API row cap (500 rows / 5 MB) — narrow it with --where / --limit / a tighter query"
    : null;
}

/** `kleap search-console` one-liner. */
export function formatSearchConsole(s) {
  if (s?.connected === false || s?.site_selected === false) {
    return `not connected — ${s?.message || "run: kleap search-console connect <app>"}`;
  }
  const ctr = typeof s?.ctr === "number" ? `${(s.ctr <= 1 ? s.ctr * 100 : s.ctr).toFixed(1)}%` : "?";
  const pos = typeof s?.position === "number" ? s.position.toFixed(1) : "?";
  return `${s?.period || "28d"}: ${s?.clicks ?? 0} clicks, ${s?.impressions ?? 0} impressions, CTR ${ctr}, avg position ${pos}`;
}

/** One line per table for `kleap db schema`. */
export function formatTableLine(t) {
  const cols = (t?.columns || [])
    .map((c) => `${c.name} ${c.type}${c.primary_key ? " pk" : ""}${c.nullable === false && !c.primary_key ? " not null" : ""}`)
    .join(", ");
  // row_count is the Postgres planner's ESTIMATE (null = never analyzed).
  const n = t?.row_count != null ? ` (~${t.row_count} rows)` : "";
  return `${t?.name}${n}: ${cols}`;
}

/** One line per chat message for `kleap messages`. */
export function formatMessageLine(m) {
  return `${m?.created_at || "?"}\t${m?.role || "?"}\t${oneLine(m?.content, 140)}`;
}

/** Parse a JSON CLI argument, with a message that names the flag. */
export function parseJsonArg(raw, name) {
  if (raw == null || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error(`${name} is not valid JSON: ${oneLine(raw, 60)}`);
    err.code = "usage";
    throw err;
  }
}

/**
 * Actionable next step for the API error codes an agent can actually fix.
 * Shown under the `CODE: message` line (and as `hint` in --json).
 */
export function hintFor(code) {
  switch (code) {
    case "INSUFFICIENT_SCOPE":
      return "Create a new API key with the Full preset (https://kleap.co/settings/api-key), then retry with it.";
    case "DATABASE_NOT_PROVISIONED":
      return 'This app has no Kleap Database yet — ask the AI to add one: kleap edit <app> "add a database", then retry.';
    case "UNSUPPORTED_STATEMENT":
      return "Raw SQL accepts one query (SELECT/WITH/VALUES/TABLE), INSERT/UPDATE/DELETE/MERGE, or DDL (CREATE/ALTER/DROP…). No EXPLAIN/SHOW/COPY/CALL, no multi-statement script with a query or RETURNING — use `kleap db rows|insert|update|delete` instead.";
    case "RLS_REQUIRED":
      return "Public tables must have row level security: add `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` (and policies) to the same SQL.";
    case "RATE_LIMITED":
      return "Too many requests — wait a minute (honor Retry-After) and retry once.";
    case "PLAN_REQUIRED":
      return "This needs a paid Kleap plan — the user can upgrade at https://kleap.co/pricing.";
    case "INSUFFICIENT_CREDITS":
      return "Not enough credits — check `kleap credits` and ask the user to top up; do not retry.";
    case "UNAUTHORIZED":
      return "The API key is missing, wrong or revoked — `kleap auth login` or set a valid KLEAP_API_KEY.";
    case "NOT_FOUND":
      return null;
    default:
      return null;
  }
}

export const HELP = (version) => `kleap v${version} — CLI for AI agents to build, edit and publish real websites (Kleap)

Usage:
  kleap auth login | key <KEY> | logout | status   Sign in (browser OAuth) / store a key / sign out / show auth

 Build & publish
  kleap create "<prompt>" [--visibility public|personal] [--webhook url] [--no-wait]
  kleap edit <app> "<prompt>" [--webhook url] [--no-wait]    Ask Kleap's AI to change a site
  kleap publish <app> [--no-wait]         Publish/redeploy (verified-live)
  kleap task <task_id> [--wait]           Status of a create/edit task (long-poll with --wait)
  kleap task retry <task_id> [--wait]     Resume a failed/stalled task (new task id)

 Apps
  kleap status <app>                      One app's status (live URL or not published)
  kleap list [--limit N] [--offset N] [--q text]   Your apps
  kleap rename <app> <name>               Rename (the URL never changes)
  kleap wake <app>                        Wake a sleeping preview sandbox
  kleap screenshot <app>                  Capture a preview screenshot URL
  kleap messages <app> [--limit N]        The app's chat history
  kleap credits                           Remaining credits + plan

 Files (your code, deterministic — then \`kleap publish <app>\`)
  kleap files ls <app>
  kleap files cat <app> <path...>
  kleap files write <app> <path> --file <local> | --stdin | --content "<text>"
  kleap files edit <app> <path> --find "<old>" --replace "<new>" [--all]
  kleap files rm <app> <path...>
  kleap image <app> <public/name.webp> "<prompt>" [--hd] [--width N --height N]

 Leads, traffic, SEO
  kleap forms <app> [--since ISO] [--limit N]   Form submissions (leads), newest first
  kleap analytics <app> [--period 7d|30d|90d]
  kleap search-console <app> [--period 7d|28d|30d|90d]   Google Search Console numbers
  kleap search-console connect <app>      Get the Google consent link (user opens it)

 Database (the app's Postgres)
  kleap db schema <app>
  kleap db rows <app> <table> [--where '{"col":"v"}'] [--limit N] [--offset N] [--order-by col --order asc|desc]
  kleap db insert <app> <table> '<json object|array>' | --file rows.json
  kleap db update <app> <table> --where '{"id":1}' --set '{"status":"done"}'
  kleap db delete <app> <table> --where '{"id":1}'
  kleap db sql <app> "<sql>" [--params '[1,"x"]']   (needs database:write, even for SELECT)

 Domains
  kleap domains search <name> [--tlds .com,.io]   Available domains + price
  kleap domains buy <domain> [--years N] [--app <app>]   Checkout link — the USER pays it
  kleap domains check <domain>            DNS / connection status of a domain
  kleap domains connect <domain> <app>    Connect a domain the user already owns

  kleap mcp                               Run the MCP stdio server explicitly

<app> accepts an app id, a kleap.io slug/URL, or a connected custom domain.
Every command takes --json (full structured output, errors too). Exit 0 = ok, 1 = failure.

Env: KLEAP_API_KEY (bearer token, wins over stored auth), KLEAP_API_URL (default https://kleap.co)
Docs: https://kleap.co/mcp · https://github.com/kleaphq/cli

Run with NO arguments (or \`kleap mcp\`) to start the MCP stdio server instead —
that's what MCP clients (Claude Desktop, Cursor, ChatGPT connectors) expect.`;
