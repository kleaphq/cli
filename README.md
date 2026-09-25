# Kleap — website infrastructure for AI agents

[![CI](https://github.com/kleaphq/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kleaphq/cli/actions/workflows/ci.yml)
[![CLI](https://img.shields.io/badge/CLI-kleap-16b364)](#cli-for-agent-shells--claude-code-codex-scripts)
[![MCP](https://img.shields.io/badge/MCP-server-2563eb)](https://modelcontextprotocol.io)
[![33 tools](https://img.shields.io/badge/tools-33-ff0055)](#tools)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

> **Your agent builds. Kleap ships it live.**
> Let any AI agent — Claude, ChatGPT, Cursor, or a bash-tool agent like Claude
> Code — build, edit and **publish real, live websites** for you. Hosting,
> database, auth and domains included.

An alternative to Lovable / v0 / Bolt — except it's driven by **your** agent, and
every publish comes with the **verified-live guarantee**: a site is only ever
reported online once it is *provably serving* — never a hallucinated dead link.

This package is **both** a CLI (`kleap create "…"`, `kleap publish 42`, …) and an
[MCP](https://modelcontextprotocol.io) server (`kleap mcp` / no args) — same
account, same `~/.kleap/config.json` auth, same underlying `/api/v1` REST API.
Pick whichever fits your agent: a shell/bash-tool agent (Claude Code, a cron
script, CI) wants the **CLI** — one compact line per call, no JSON-RPC framing.
An MCP-native client (Claude Desktop, Cursor, ChatGPT connectors) wants the
**MCP server**, which this package also is, unchanged.

![A real, unedited run: an agent writes a page with write_files, publishes, and it is live and serving in seconds.](https://raw.githubusercontent.com/kleaphq/cli/main/assets/demo.gif)

> *Above: a real run — your agent writes the code with `write_files`, `publish_app` builds & deploys it, and the page is live in seconds. Or just ask Kleap's AI in plain English.*

**No secrets live in this package** — it reads your own `KLEAP_API_KEY` (or the
token saved by `kleap auth login`) and talks only to `kleap.co`.

---

## CLI (for agent shells — Claude Code, Codex, scripts)

If your agent drives a **bash tool** rather than MCP, use the CLI directly.
Output is 1-3 lines by default (token-efficient — built for an agent reading
its own tool output, not a human terminal), clean exit codes (`0`/`1`), and a
`--json` flag whenever you want the full structured response.

```bash
npx -y kleap-cli auth login              # opens your browser once, no key to paste
# — or, for CI / non-interactive: npx -y kleap-cli auth key kleap_live_sk_...

npx -y kleap-cli create "a one-page site for my bakery, warm palette"
# ✓ created app 4821 — https://warm-bakery-fold.kleap.io

npx -y kleap-cli edit 4821 "change the headline to 'Roasted slow'"
# ✓ edited app 4821 — https://warm-bakery-fold.kleap.io

npx -y kleap-cli publish 4821
# ✓ published https://warm-bakery-fold.kleap.io

npx -y kleap-cli status warm-bakery-fold.kleap.io   # by id, slug, kleap.io URL, or connected custom domain
# ✓ Bakery (4821) — live: https://warm-bakery-fold.kleap.io
```

### Commands

| Command | What it does |
|---|---|
| `kleap auth login` | Sign in via browser (OAuth, PKCE loopback) — no key to copy |
| `kleap auth key <KEY>` | Store a `kleap_live_sk_...` key instead (CI / non-interactive) |
| `kleap auth logout` / `kleap auth status` | Clear / show current auth |
| `kleap create "<prompt>" [--visibility public\|personal] [--webhook <url>] [--no-wait] [--json]` | Create a site, wait for the build (~5-15 min), print the live URL |
| `kleap edit <app> "<prompt>" [--webhook <url>] [--no-wait] [--json]` | Ask Kleap's AI to change a site, wait for it to redeploy |
| `kleap publish <app> [--no-wait] [--json]` | Publish/redeploy with the verified-live guarantee |
| `kleap status <app> [--json]` | One-line status: name, id, live URL or "not published" |
| `kleap list [--limit N] [--q text] [--json]` | Your apps, one tab-separated row each: `id  name  url` |
| `kleap domains search <query> [--tlds .com,.io] [--json]` | Available domains, one per line |
| `kleap domains connect <domain> <app> [--json]` | Connect a domain you own; prints the A record to set |
| `kleap screenshot <app>` | Capture a preview screenshot, print its URL |
| `kleap task <task_id> [--wait]` / `kleap task retry <task_id> [--wait]` | A create/edit task's status (long-poll with `--wait`) / resume a failed one |
| `kleap rename <app> <name>` · `kleap wake <app>` · `kleap messages <app>` · `kleap credits` | Rename (URL unchanged) · wake a preview sandbox · chat history · credit balance + plan |
| `kleap files ls <app>` · `files cat <app> <path...>` | List source paths · print file contents |
| `kleap files write <app> <path> --file <local> \| --stdin \| --content "<text>"` | Write a file (binary extensions go base64 automatically, 512 KB max) → then `publish` |
| `kleap files edit <app> <path> --find "<old>" --replace "<new>" [--all]` | Replace text inside a file |
| `kleap files rm <app> <path...>` | Delete pages/assets (live until the next `publish`) |
| `kleap image <app> <public/name.webp> "<prompt>" [--hd]` | Generate an image into the site → then `publish` |
| `kleap forms <app> [--since ISO] [--limit N]` | Form submissions (leads), newest first; `--json` is flattened |
| `kleap analytics <app> [--period 7d\|30d\|90d]` | Visitors, pageviews, top pages |
| `kleap search-console <app>` · `search-console connect <app>` | Google Search numbers · the consent link the user opens |
| `kleap db schema <app>` | Tables, row counts, columns of the app's Postgres |
| `kleap db rows <app> <table> [--where json] [--limit] [--offset] [--order-by col --order asc\|desc]` | Read rows (one JSON object per line) |
| `kleap db insert <app> <table> '<json>'\|--file rows.json` | Insert one object or an array (chunked at 500) |
| `kleap db update <app> <table> --where json --set json` · `db delete <app> <table> --where json` | `--where` is mandatory and non-empty |
| `kleap db sql <app> "<sql>" [--params json]` | One SQL statement with `$1..$n` params (owner-level: needs `database:write` even for SELECT; 500 rows / 5 MB cap) |
| `kleap domains buy <domain> [--years N] [--app <app>]` | Creates a Stripe checkout link **the user pays** — never bought until they do |
| `kleap domains check <domain>` | DNS / connection status (also: did the paid domain get registered?) |
| `kleap mcp` | Run the MCP stdio server explicitly (same as no args) |

`<app>` accepts a numeric app id, a `slug.kleap.io` URL, a bare slug, or a
connected custom domain — resolved server-side in one call
(`GET /apps/resolve`), same as the MCP `find_app` tool.

### Example: a Claude Code / bash-tool agent

```bash
# One-shot: build it, publish it, hand back a URL a human can click.
url=$(npx -y kleap-cli create "a landing page for my podcast" --json | node -e \
  'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).url))')
echo "Live: $url"

# Non-blocking flow (agent does other work while it builds):
npx -y kleap-cli create "a landing page for my podcast" --no-wait --json   # → { task_id, app_id, ... }
# ... later ...
npx -y kleap-cli status 4821
```

Exit codes are always clean: `0` on success, `1` on any failure, with a single
`✗ <reason>` line on stderr (or `{"error":{"message":...}}` with `--json`) —
safe to check with `$?` / `try/except subprocess.run(..., check=True)` without
scraping prose.

### Install once (optional — `npx -y` above needs no install)

```bash
npm i -g kleap-cli
kleap auth login
kleap create "a one-page site for my bakery"
```

---

## MCP server (for MCP-native clients — Claude Desktop, Cursor, ChatGPT)

Same package, same account, same `~/.kleap/config.json` auth — just a
different transport for clients that speak [MCP](https://modelcontextprotocol.io)
instead of a bash tool.

### Easiest — connect with OAuth, no key

Add the hosted connector and sign in. **Nothing to generate, nothing to paste** —
you authorize Kleap in your browser like any other app. Works in Claude Desktop,
ChatGPT and Cursor.

```
https://kleap.co/api/mcp
```

- **Claude Desktop** — Settings → Connectors → **Add custom connector** → paste the URL → **Connect** → sign in to Kleap.
- **ChatGPT** — Settings → Connectors → add the URL → authorize with OAuth.
- **Cursor** — Settings → **MCP** → Add server → paste the URL → authorize.

That's it — all 26 hosted tools are available after OAuth sign-in. Skip straight to step 3.

---

### Or — local CLI, sign in with your browser (no key)

Prefer a local stdio process? Sign in once — no key to generate or paste:

```
npx kleap-cli auth login
```

This opens your browser, you authorize Kleap, and the token is saved to
`~/.kleap/config.json`. After that, `npx -y kleap-cli` just works. (`kleap auth
logout` / `kleap auth status` are there too.) Then add a keyless stdio entry to
your client, e.g. Claude Desktop `claude_desktop_config.json`:

```json
{ "mcpServers": { "kleap": { "command": "npx", "args": ["-y", "kleap"] } } }
```

---

### Or — local CLI with an API key

Prefer a key (e.g. for CI or scripting the REST API directly)?

**1. Get an API key** — open [kleap.co/settings/api-key](https://kleap.co/settings/api-key) and click **Create my API key** (`kleap_live_sk_...`).

**2. Add Kleap to your AI client:**

<details open>
<summary><b>Claude Desktop</b> — <code>claude_desktop_config.json</code></summary>

```json
{
  "mcpServers": {
    "kleap": {
      "command": "npx",
      "args": ["-y", "kleap"],
      "env": { "KLEAP_API_KEY": "kleap_live_sk_..." }
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b> — <code>.cursor/mcp.json</code></summary>

```json
{
  "mcpServers": {
    "kleap": {
      "command": "npx",
      "args": ["-y", "kleap"],
      "env": { "KLEAP_API_KEY": "kleap_live_sk_..." }
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code</b> — one command</summary>

```bash
claude mcp add kleap -e KLEAP_API_KEY=kleap_live_sk_... -- npx -y kleap-cli
```
</details>

<details>
<summary><b>Cline / Roo (VS Code)</b> — <code>cline_mcp_settings.json</code></summary>

```json
{
  "mcpServers": {
    "kleap": {
      "command": "npx",
      "args": ["-y", "kleap"],
      "env": { "KLEAP_API_KEY": "kleap_live_sk_..." }
    }
  }
}
```
</details>

<details>
<summary><b>Windsurf</b> — <code>~/.codeium/windsurf/mcp_config.json</code></summary>

```json
{
  "mcpServers": {
    "kleap": {
      "command": "npx",
      "args": ["-y", "kleap"],
      "env": { "KLEAP_API_KEY": "kleap_live_sk_..." }
    }
  }
}
```
</details>

<details>
<summary><b>ChatGPT &amp; hosted agents</b> — no local process</summary>

Add the hosted connector at **`https://kleap.co/api/mcp`** and authorize with
OAuth (or paste your `kleap_live_sk_` key). Same tools, no install.
</details>

> Every stdio config is identical — `npx -y kleap-cli` + a `KLEAP_API_KEY` env var —
> so any MCP client works.

**Least-privilege keys:** when you generate a key, pick a scope — **Read-only**
(inspect sites, no changes), **Build**, or **Full**. Buying domains is never
included by default. Give a read-only agent a read-only key.

**3. Restart the client and just ask:**

> *"Build me a one-page site for my bakery, publish it, and give me the live URL."*
> *"Add a contact form to my site and redeploy."*
> *"Change the headline to 'Roasted slow' and publish."*

Works with **any MCP-compatible agent**: Claude · ChatGPT · Cursor · Claude Code · Codex.

---

## Tools

**Find & build** — `find_app` · `create_app` · `modify_app` · `check_task` · `retry_task` · `rename_app` · `get_screenshot` · `wake_app`
**Files** — `list_app_files` · `read_files` · `write_files` · `edit_files` · `delete_files` · `generate_image`
**Publish & domains** — `publish_app` · `get_publish_status` · `search_domains` · `buy_domain` · `check_domain` · `connect_domain`
**Leads, traffic, SEO** — `get_form_submissions` · `get_analytics` · `get_search_console` · `connect_search_console`
**Database** — `get_database_schema` · `query_database_rows` · `insert_database_rows` · `update_database_rows` · `delete_database_rows` · `run_database_sql`
**Account** — `list_apps` · `get_app` · `get_credits`

| Tool | What it does |
|------|--------------|
| `find_app` | Resolve a domain / URL / slug → app_id in one call |
| `create_app` / `modify_app` | Build a site from a prompt / ask its AI for a change → returns a task (auto-deploys live) |
| `check_task` / `retry_task` | Long-poll a task (`wait` up to 50s) / resume a failed one (new task_id) |
| `read_files` → `edit_files` / `write_files` / `delete_files` | Read current contents, then change exactly what must change (base64 for binaries) → `publish_app` |
| `generate_image` | Generate a real image into `public/` without sending bytes |
| `publish_app` / `get_publish_status` | Publish with verified-live; confirm it + read the post-deploy report |
| `search_domains` / `buy_domain` | Find domains / create a checkout link **the user pays** (nothing is bought by the agent) |
| `connect_domain` / `check_domain` | Connect a domain the user owns / its DNS status |
| `get_form_submissions` | The site's leads, newest first (`since` for only new ones) |
| `get_analytics` / `get_search_console` / `connect_search_console` | Traffic / Google Search numbers / consent link for Search Console |
| `get_database_schema` … `run_database_sql` | The app's Postgres: schema, row CRUD (`where` required for update/delete), SQL |
| `rename_app` / `get_screenshot` / `wake_app` | Rename (URL unchanged) / screenshot URL / wake a preview sandbox |
| `list_apps` / `get_app` / `get_credits` | Your apps, one app's details, credit balance + plan |

Database and checkout tools need the `database:*` / `domains:checkout` scopes: a key
created before they existed gets `403 INSUFFICIENT_SCOPE` — create a new key with the **Full** preset.

App arguments are snake_case: `app_id`, `task_id`, `prompt`, `message`, `visibility`.

## Recipes

**Two ways to put code on a site — pick per task:**
- **`write_files` (deterministic):** *your* model writes the exact file contents; you push them and Kleap builds + deploys as-is. No Kleap-AI step → no Kleap credits, never stalls. Then `publish_app`. Unlike Lovable/v0/Bolt, your agent can write the code itself.
- **`modify_app` (Kleap's AI):** describe the outcome in plain English and Kleap's AI writes it. Like Lovable's message-passing — kept for when you'd rather it figure out the change.

Either way Kleap hosts it (build, deploy, SSL, DB, auth, domains, verified-live).

- **Edit existing files SAFELY (don't rewrite blind)** — `list_app_files(app_id)` → `read_files(app_id, ["src/components/Header.astro"])` → edit only what must change with your own model → `write_files(app_id, [{ path, content }])` → `publish_app(app_id)`. This read→edit→write loop is the reliable way to fix headers/footers, wrong phone numbers, broken links or dead forms without breaking the rest of the site.
- **Edit a site named by its address** — `find_app("mysite.ch")` → `read_files(...)` → `write_files(...)` → `publish_app(...)`, or `modify_app(app_id, "…")` → `check_task(task_id, wait=45)`.
- **Many pages (programmatic SEO) — BEST:** generate a dynamic route + a data file with your own model and push them in one `write_files`, then `publish_app`:
  > `write_files(app_id, [{ path: "src/pages/[service]/[city].astro", content: … }, { path: "src/data/locations.json", content: … }])` → `publish_app(app_id)`
  Deterministic, scales to thousands, no stall, no credits. (Or ask Kleap's AI to do the same in one `modify_app` — never loop one call per page.)
- **Don't babysit a 5-15 min build** — `check_task` long-polls (default `wait=45`),
  or pass a `webhook_url` to `create_app` / `modify_app` for a fully hands-off flow.
- **A build failed** — `TASK_TIMEOUT`/`STALE_TASK` = transient, call `retry_task`; it
  returns a **new** task_id — poll *that* one. `TASK_FAILED` = read the message, retry once.

## The verified-live guarantee

Most tools tell the agent "it's online" the moment a deploy is *requested*. Kleap
reports a site as published **only once the new version is provably serving** at
its live URL — otherwise it rolls back and reports "not confirmed live." Your
agent can never hand a user a dead link.

If `check_task` reports `failed` (a transient generation stall), call `retry_task`
with that `task_id` to resume from where it stopped — it returns a **new** task_id
to poll, and partial work is kept. Or skip the AI entirely and `write_files` the
exact code yourself, then `publish_app`.

## FAQ

**Do I need an API key?** No. The easiest path is the OAuth connector
(`https://kleap.co/api/mcp`) — you sign in with your browser and never copy a
key. An API key is only needed for the local CLI / direct REST use.

**Is it safe?** Yes. Whether you connect with OAuth or an API key, an agent can
only ever touch *your own* Kleap apps. OAuth tokens and `kleap_live_sk_` keys are
scoped, sent only over HTTPS, and revocable anytime in **https://kleap.co/settings/api-key**.
Credentials from `kleap auth login` / `kleap auth key` are stored in
`~/.kleap/config.json` (permissions `0600`); **`kleap auth logout` deletes that
file**. A stored OAuth login is **bound to the origin that issued it** — if
`KLEAP_API_URL` points anywhere else, the CLI refuses to send the token
(`CREDENTIAL_ORIGIN_MISMATCH`) so a malicious/typo'd endpoint can't capture it.
For custom endpoints (e.g. staging), use `KLEAP_API_KEY` or `kleap auth key` —
an explicit secret you provide is sent where you point it. Details in
[SECURITY.md](./SECURITY.md).

**How much does it cost?** Connecting is free. Builds and edits use Kleap credits
(`get_credits` reports your balance) — see [pricing](https://kleap.co/pricing).

**Which agents work?** Any MCP client: Claude Desktop, Claude Code, Cursor,
ChatGPT (hosted connector), and others.

## Requirements & run

Node ≥ 18. Run it directly:

```bash
KLEAP_API_KEY=kleap_live_sk_... npx -y kleap-cli
# → [kleap-mcp] ready (stdio) → https://kleap.co. Tools: list_apps, ...
```

Override the API base with `KLEAP_API_URL` (default `https://kleap.co`).
Missing key → the server exits with a clear message. Note: a stored OAuth
login only works against the origin it was issued by — with a custom
`KLEAP_API_URL`, authenticate via `KLEAP_API_KEY` or `kleap auth key` instead
(see [SECURITY.md](./SECURITY.md)).

## Links

- Kleap: https://kleap.co · MCP & CLI page: https://kleap.co/mcp
- Issues & security: https://github.com/kleaphq/cli/issues

Maintained by the [Kleap](https://kleap.co) team. MIT © Kleap.
