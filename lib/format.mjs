// Pure, dependency-free helpers shared by the CLI dispatch (kleap-mcp-server.mjs)
// and the unit tests. No I/O, no process.exit, no network — safe to import
// anywhere without side effects.

/** Split argv into positional args + known --flags (agent-friendly, no lib). */
export function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") flags.json = true;
    else if (a === "--no-wait") flags.noWait = true;
    else if (a === "--visibility") flags.visibility = args[++i];
    else if (a === "--webhook") flags.webhook = args[++i];
    else if (a === "--limit") flags.limit = args[++i];
    else if (a === "--q" || a === "--query") flags.q = args[++i];
    else if (a === "--tlds") flags.tlds = args[++i];
    else positional.push(a);
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

export const HELP = (version) => `kleap v${version} — CLI for AI agents to build, edit and publish real websites (Kleap)

Usage:
  kleap auth login                        Sign in via browser (OAuth, no key)
  kleap auth key <KEY>                    Store a Kleap API key (kleap_live_sk_...)
  kleap auth logout                       Clear stored credentials
  kleap auth status                       Show current auth state
  kleap create "<prompt>" [flags]         Create a new site, wait for it to build
  kleap edit <app> "<prompt>" [flags]     Ask Kleap's AI to change a site
  kleap publish <app> [flags]             Publish/redeploy (verified-live)
  kleap status <app> [--json]             Show one app's status
  kleap list [--limit N] [--q text]       List your apps
  kleap domains search <query> [--tlds]   Search available domains
  kleap domains connect <domain> <app>    Connect a domain you own
  kleap screenshot <app> [--json]         Capture a preview screenshot
  kleap mcp                               Run the MCP stdio server explicitly

<app> accepts an app id, a kleap.io slug/URL, or a connected custom domain.
Flags: --json (structured output), --no-wait (don't poll to completion),
       --visibility public|personal (create), --webhook <url> (create/edit).

Env: KLEAP_API_KEY (bearer token, wins over stored auth), KLEAP_API_URL (default https://kleap.co)
Docs: https://kleap.co/mcp · https://github.com/Kleap-co/kleap

Run with NO arguments (or \`kleap mcp\`) to start the MCP stdio server instead —
that's what MCP clients (Claude Desktop, Cursor, ChatGPT connectors) expect.`;
