---
name: kleap
description: >-
  Build, edit and publish real websites with Kleap from inside this agent, via
  the Kleap MCP server. Use when the user wants to create a website or web app,
  change a site they made on Kleap, connect a domain, or take a site live —
  especially when they want it actually hosted and online, not just code. Kleap
  provides the hosting, database, auth, domains and a verified-live publish.
---

# Driving Kleap

Kleap is website infrastructure for agents: you describe a site, Kleap builds it
(hosting + database + auth included), connects a domain, and publishes it with a
**verified-live guarantee**. You drive it through the Kleap MCP tools
(`create_app`, `modify_app`, `check_task`, `publish_app`, etc.).

## The golden rule: never claim a site is live until Kleap confirms it

A deploy being *started* is NOT the same as a site being *online*. Only state
that a site is live after `get_publish_status` (or `check_task`) returns
`status: "published"` with a `production_url`. If it isn't confirmed, say so
plainly — never invent a working URL.

## Core flow — create a site

1. `create_app({ prompt })` — give a detailed description. Returns `{ app_id, task_id }`.
2. Poll `check_task({ task_id })` every ~10–15s until `status` is `completed` or `failed`. Building usually takes a couple of minutes (up to ~15 for complex sites) — check_task long-polls so you don't babysit it.
3. If `failed` (transient stalls happen): call `retry_task({ task_id })` with the
   SAME task_id — it resumes from partial state and preserves files already
   written. Do not start a brand-new `create_app`. Then poll `check_task` on the
   new task_id. Retry once or twice before giving up.
4. `publish_app({ app_id })` → then poll `get_publish_status({ app_id })` until
   `status: "published"`. Report the `production_url` only then.

## Edit an existing site

`modify_app({ app_id, message })` with a clear, specific instruction (e.g.
"Change the headline to X and make the background charcoal"). It returns a task —
poll `check_task`, then `publish_app` to push the change live. Editing is
reliable; prefer it over recreating.

## Precise edits (your own code)

`list_app_files` → `read_files` → `edit_files` (old_string → new_string) or
`write_files` (new files; `encoding: "base64"` for images/fonts) or
`delete_files` → `publish_app`. `generate_image({ app_id, path: "public/x.webp", prompt })`
adds a real generated image without sending bytes.

## Leads, traffic, database

- `get_form_submissions({ app_id, since? })` — the site's leads, newest first.
- `get_analytics({ app_id, period })`, `get_search_console({ app_id })`
  (not connected → `connect_search_console` returns a link the USER opens).
- `get_database_schema` → `query_database_rows` / `insert_database_rows` /
  `update_database_rows` / `delete_database_rows` (`where` is required) /
  `run_database_sql`. `DATABASE_NOT_PROVISIONED` → `modify_app` "add a database"
  first. `RLS_REQUIRED` → enable row level security in the same SQL.
- `403 INSUFFICIENT_SCOPE` → the user must create a new API key with the **Full** preset.

## Domains

- `search_domains({ query })` — find available names and prices.
- `buy_domain({ domain, years?, app_id? })` — returns a `checkout_url` that the
  **user** opens and pays. Nothing is bought until they pay: never say "bought"
  or "live" before `check_domain` confirms it.
- `connect_domain({ app_id, domain })` — connect a domain the user ALREADY owns
  to a published app. The user points the domain's A record to Kleap; TLS is automatic.
- `check_domain({ domain })` — DNS / connection status.

## Conventions

- Arguments are snake_case: `app_id`, `task_id`, `prompt`, `message`, `visibility`.
- `visibility` is `"personal"` (private, default) or `"public"` (discoverable).
- Use `get_credits` if a create/modify fails for quota reasons.
- One app per site. Keep the user's `app_id` to make later edits.

## What good looks like

> User: "Make me a landing page for my bakery and put it online."
> You: create_app → poll check_task → publish_app → poll get_publish_status →
> "It's live at your-bakery.kleap.io ✅" (only after it's confirmed serving).
