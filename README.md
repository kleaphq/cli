# Kleap — website infrastructure for AI agents

[![CI](https://github.com/Kleap-co/kleap/actions/workflows/ci.yml/badge.svg)](https://github.com/Kleap-co/kleap/actions/workflows/ci.yml)
[![CLI](https://img.shields.io/badge/CLI-kleap-16b364)](#cli-for-agent-shells--claude-code-codex-scripts)
[![MCP](https://img.shields.io/badge/MCP-server-2563eb)](https://modelcontextprotocol.io)
[![17 tools](https://img.shields.io/badge/tools-17-ff0055)](#tools)
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

![A real, unedited run: an agent writes a page with write_files, publishes, and it is live and serving in seconds.](https://raw.githubusercontent.com/Kleap-co/kleap/main/assets/demo.gif)

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
npx -y kleap auth login              # opens your browser once, no key to paste
# — or, for CI / non-interactive: npx -y kleap auth key kleap_live_sk_...

npx -y kleap create "a one-page site for my bakery, warm palette"
# ✓ created app 4821 — https://warm-bakery-fold.kleap.io

npx -y kleap edit 4821 "change the headline to 'Roasted slow'"
# ✓ edited app 4821 — https://warm-bakery-fold.kleap.io

npx -y kleap publish 4821
# ✓ published https://warm-bakery-fold.kleap.io

npx -y kleap status warm-bakery-fold.kleap.io   # by id, slug, kleap.io URL, or connected custom domain
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
| `kleap screenshot <app> [--json]` | Capture a preview screenshot, print its URL |
| `kleap mcp` | Run the MCP stdio server explicitly (same as no args) |

`<app>` accepts a numeric app id, a `slug.kleap.io` URL, a bare slug, or a
connected custom domain — resolved server-side in one call
(`GET /apps/resolve`), same as the MCP `find_app` tool.

### Example: a Claude Code / bash-tool agent

```bash
# One-shot: build it, publish it, hand back a URL a human can click.
url=$(npx -y kleap create "a landing page for my podcast" --json | node -e \
  'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).url))')
echo "Live: $url"

# Non-blocking flow (agent does other work while it builds):
npx -y kleap create "a landing page for my podcast" --no-wait --json   # → { task_id, app_id, ... }
# ... later ...
npx -y kleap status 4821
```

Exit codes are always clean: `0` on success, `1` on any failure, with a single
`✗ <reason>` line on stderr (or `{"error":{"message":...}}` with `--json`) —
safe to check with `$?` / `try/except subprocess.run(..., check=True)` without
scraping prose.

### Install once (optional — `npx -y` above needs no install)

```bash
npm i -g kleap
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

That's it — same 17 tools, no API key. Skip straight to step 3.

---

### Or — local CLI, sign in with your browser (no key)

Prefer a local stdio process? Sign in once — no key to generate or paste:

```
npx kleap auth login
```

This opens your browser, you authorize Kleap, and the token is saved to
`~/.kleap/config.json`. After that, `npx -y kleap` just works. (`kleap auth
logout` / `kleap auth status` are there too.) Then add a keyless stdio entry to
your client, e.g. Claude Desktop `claude_desktop_config.json`:

```json
{ "mcpServers": { "kleap": { "command": "npx", "args": ["-y", "kleap"] } } }
```

---

### Or — local CLI with an API key

Prefer a key (e.g. for CI or scripting the REST API directly)?

**1. Get an API key** — at [kleap.co](https://kleap.co) → **Settings → API key →
MCP / API access → Generate MCP key** (`kleap_live_sk_...`).

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
claude mcp add kleap -e KLEAP_API_KEY=kleap_live_sk_... -- npx -y kleap
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

> Every stdio config is identical — `npx -y kleap` + a `KLEAP_API_KEY` env var —
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

**Find & build** — `find_app` · `create_app` · `modify_app` · `read_files` · `write_files` · `rename_app` · `check_task` · `retry_task`
**Publish & domains** — `publish_app` · `get_publish_status` · `search_domains` · `check_domain` · `connect_domain`
**Account** — `list_apps` · `get_app` · `list_app_files` · `get_credits`

| Tool | What it does |
|------|--------------|
| `find_app` | Resolve a domain / URL / slug → app_id in one call |
| `create_app` | Create an Astro site from a prompt → returns a task (auto-deploys live) |
| `modify_app` | Ask the app's AI to change it → returns a task |
| `read_files` | Read the **current contents** of files so you can edit them safely (not blind) |
| `write_files` | Write exact files directly (**your** code, deterministic) → then `publish_app` |
| `rename_app` | Rename the display name (URL stays the same) |
| `check_task` | Long-poll a create/modify task to completion (`wait` up to 50s) |
| `retry_task` | Resume a failed/stalled build from partial state (new task_id) |
| `publish_app` | Publish with verified-live (live-or-rollback, never a false "online") |
| `get_publish_status` | Confirm a site is actually published + live |
| `search_domains` | Find available domains (purchase stays user-confirmed in Kleap) |
| `connect_domain` | Connect a domain you already own to a live app |
| `check_domain` | A domain's connection / DNS status |
| `list_apps` / `get_app` / `list_app_files` | Your apps, an app's details, its files (read-only) |
| `get_credits` | Remaining credit balance + plan |

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
scoped, sent only over HTTPS, and revocable anytime in **Settings → API key**.
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
KLEAP_API_KEY=kleap_live_sk_... npx -y kleap
# → [kleap-mcp] ready (stdio) → https://kleap.co. Tools: list_apps, ...
```

Override the API base with `KLEAP_API_URL` (default `https://kleap.co`).
Missing key → the server exits with a clear message. Note: a stored OAuth
login only works against the origin it was issued by — with a custom
`KLEAP_API_URL`, authenticate via `KLEAP_API_KEY` or `kleap auth key` instead
(see [SECURITY.md](./SECURITY.md)).

## Links

- Kleap: https://kleap.co · MCP & CLI page: https://kleap.co/mcp
- Issues & security: https://github.com/Kleap-co/kleap/issues

Maintained by the [Kleap](https://kleap.co) team. MIT © Kleap.
