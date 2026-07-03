# Security

## Reporting a vulnerability

Email **security@kleap.co** (or open a private security advisory on this repo).
Please do not file public issues for vulnerabilities.

## What's in this package

This CLI / MCP server is a thin client over Kleap's public REST API:

- **No credentials are bundled.** It uses your own credentials (below) and
  collects **no telemetry**.
- A single runtime dependency: `@modelcontextprotocol/sdk`.

## Where credentials live

Two credential models, with different trust rules:

- **`KLEAP_API_KEY` env var** — read from the environment only, never written
  to disk by this tool. As an explicit secret you provide, it is sent to
  whatever endpoint you configure (`KLEAP_API_URL`, default `https://kleap.co`)
  over HTTPS.
- **`kleap auth login` (OAuth) / `kleap auth key <KEY>`** — saved to
  **`~/.kleap/config.json`** (directory `0700`, file `0600`). This is the only
  file this tool writes.

To revoke local access, run **`kleap auth logout`** — it deletes
`~/.kleap/config.json` entirely. Server-side, revoke keys/tokens anytime at
**kleap.co → Settings → API key**.

## Credential origin binding (`KLEAP_API_URL`)

A stored **OAuth login is bound to the origin that issued it** (recorded in the
config at login time). If `KLEAP_API_URL` points anywhere else, the CLI
**refuses to use the stored OAuth token** (`CREDENTIAL_ORIGIN_MISMATCH`) rather
than sending your session Bearer — and its refresh token is **only ever posted
to the issuing origin**, never to an env override. This prevents a malicious or
typo'd `KLEAP_API_URL` from exfiltrating stored tokens.

Explicit secrets (`KLEAP_API_KEY` env, `kleap auth key`) are exempt: you
knowingly provided that secret for the endpoint you configure, so they work
with custom `KLEAP_API_URL` values (e.g. staging). Don't point a production
key at an endpoint you don't trust.

## Handling your API key

- Keep `kleap_live_sk_...` keys in your MCP client config — never commit them.
- Keys are shown once and are **scoped to your own account**; an agent can only
  act on apps you own.
- Rotate or revoke anytime at **kleap.co → Settings → API key**.
- For hosted agents (ChatGPT), prefer the OAuth connector over a pasted key.
