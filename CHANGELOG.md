# Changelog

## 2.0.0

- **Renamed the package `@eliottd/kleap` → `kleap`.** Same CLI, same `kleap` command. Install with `npx kleap` / `npm i -g kleap`. The old `@eliottd/kleap` is deprecated and points here.


All notable changes to the Kleap MCP server / CLI.

## [1.2.1] — 2026-07-03
- **SECURITY (credential origin binding):** a stored OAuth login
  (`kleap auth login`) is now bound to the origin that issued it. Previously,
  setting `KLEAP_API_URL` to any host caused the CLI to send the stored Bearer
  token there — and an expired token would POST the long-lived
  **refresh_token** to that host, then cache whatever access_token it returned
  (config poisoning). Now: if `KLEAP_API_URL` differs from the credential's
  issuing origin, the CLI refuses with `CREDENTIAL_ORIGIN_MISMATCH` (exit 1,
  `--json` honored) and sends **zero** requests; token refreshes only ever go
  to the issuing origin. Explicit secrets (`KLEAP_API_KEY` env,
  `kleap auth key`) still work with custom endpoints — the user knowingly
  provides that secret for the endpoint they configure. See SECURITY.md.
- **Backward compat with 1.1.2 MCP configs:** a first argument starting with
  `-` (e.g. `kleap --stdio`) falls through to the MCP stdio server, as every
  non-`auth` argv did in 1.1.2 — existing client configs with extra flags keep
  working. Only an unknown **bare word** (`kleap bogus`) errors out, which
  protects agents from typos.
- `kleap auth logout` now deletes `~/.kleap/config.json` entirely (previously
  left an empty file behind); the config dir is created `0700`.
- `api()` honors a `Retry-After` header on 429/5xx retries (capped at 60s;
  exponential-backoff fallback).
- Docs: SECURITY.md / README no longer claim "writes nothing to disk" —
  `~/.kleap/config.json` (0600) is documented along with how to revoke it, and
  the OAuth-vs-explicit-key trust distinction for `KLEAP_API_URL`.
- Tests: 7 new regression tests (origin-binding exfiltration, refresh-token
  containment, explicit-key paths, MCP-boot refusal, `-`-flag fall-through,
  logout file removal); the smoke test now asserts all 17 tools (was 14).
- Fix: `--json` is now honored on EVERY error path, not just command-body
  failures. Previously the auth guard (`not signed in`), `auth` subcommand
  usage errors, and the unknown-command path printed plain text even when
  `--json` was passed — crashing agents that `JSON.parse` the output. Root
  cause: those guards printed + exited directly instead of routing through
  the `--json`-aware error emitter. All errors now exit through one path:
  `{"error":{"code":...,"message":...}}` on stdout in JSON mode (codes:
  `not_authenticated`, `unknown_command`, `usage`, `login_failed`), plain
  `✗ ...` on stderr otherwise; exit code 1 either way. In JSON mode nothing
  stray is written to stderr. 5 regression tests added.
- `kleap auth login` failures are now a clean one-line error (previously an
  unhandled-rejection stack trace).

## [1.2.0] — 2026-07-02
- **New: `kleap` is now also a real CLI**, not just an MCP server — for agents
  that drive a bash tool (Claude Code, Codex, scripts, CI) instead of MCP.
  Compact output (1-3 lines by default), clean exit codes (`0`/`1`), `--json`
  for structured output.
  - `kleap create "<prompt>"` / `kleap edit <app> "<prompt>"` — create/change a
    site, long-poll the build to completion, print the live URL.
  - `kleap publish <app>` — publish/redeploy with the verified-live guarantee.
  - `kleap status <app>` / `kleap list` — one-line status / one row per app.
  - `kleap domains search <query>` / `kleap domains connect <domain> <app>`.
  - `kleap screenshot <app>`.
  - `kleap auth key <KEY>` — store an API key without the browser OAuth flow
    (CI / non-interactive), alongside the existing `auth login/logout/status`.
  - `--no-wait`, `--visibility`, `--webhook`, `--limit`, `--q`, `--tlds` flags.
  - `<app>` accepts an id, a kleap.io slug/URL, or a connected custom domain
    (resolved via the same `GET /apps/resolve` the MCP `find_app` tool uses).
  - `kleap mcp` runs the MCP stdio server explicitly; no args does the same
    (unchanged default — existing MCP client configs keep working as-is).
  - `kleap --help` / `kleap --version`; an unrecognized command now fails fast
    with usage instead of silently trying to speak MCP stdio JSON-RPC.
- Server handshake version now reads from `package.json` instead of being
  hardcoded (was drifting, e.g. `1.0.10` while the package was `1.1.2`).
- New `lib/format.mjs` — pure, dependency-free CLI arg-parsing/formatting
  helpers, unit-tested in isolation from network/process concerns.

## [1.1.2] — 2026-06-24
- Fix: in-CLI messages reference `npx kleap` (the real install name).

## [1.1.1] — 2026-06-24
- Docs: install as `kleap` (npm blocked the unscoped name). No code change.

## [1.1.0] — 2026-06-23
- `kleap auth login` — sign in with your browser (OAuth, PKCE, RFC 8252 loopback),
  no API key to copy. The token is saved to `~/.kleap/config.json` and used
  automatically by `npx kleap`; `kleap auth logout` / `kleap auth status` too.
- `KLEAP_API_KEY` still works and takes precedence (nothing breaks).

## [1.0.8] — 2026-06-20
- Server `instructions` (the agent "skill"): how Kleap works, the find→build→poll→publish
  loop, the programmatic-SEO pattern (one dynamic route + data file, not N page calls),
  the error-code vocabulary, and key scoping.
- `check_task` long-polls (`wait`, default 45s) so agents don't hammer a multi-minute build;
  `create_app`/`modify_app` accept a `webhook_url` for fully hands-off flows.
- `find_app` (resolve a domain / URL / slug → app_id in one call) and `rename_app`
  (display name only, URL unchanged). 15 tools total.
- Hardened `api()`: timeout + bounded retry + 429/5xx backoff + clean errors.
- Fixes: server handshake version aligned to package version; honest build-time wording;
  tool count corrected to 15 everywhere.

## [1.0.0] — 2026-06-18
- Initial public release: MCP server + CLI wrapping the Kleap `/api/v1` REST API.
- create / modify / publish with the verified-live guarantee; domains; credits.
