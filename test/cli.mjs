// End-to-end-ish CLI tests: spins up a local mock server that implements the
// exact /api/v1 request/response contract (mirrored from kleap-AI's
// app/api/v1/* route handlers), points the REAL kleap-mcp-server.mjs binary
// at it via KLEAP_API_URL, and spawns it as a child process per command —
// exercising the full path (argv parsing → HTTP call → JSON parsing → output
// formatting → exit code) without touching the real kleap.co backend or
// requiring a live API key.
//
// Run: node test/cli.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(root, "kleap-mcp-server.mjs");
const HOME = mkdtempSync(join(tmpdir(), "kleap-cli-test-"));

// Every request the mock receives, as "METHOD /path" — lets the
// origin-binding tests assert that a mismatched OAuth credential produces
// ZERO outbound requests (the token-exfiltration regression).
const SEEN = [];

// An isolated $HOME whose ~/.kleap/config.json holds the given contents —
// simulates a user with stored `kleap auth login` / `kleap auth key` creds.
function homeWithConfig(cfg) {
  const h = mkdtempSync(join(tmpdir(), "kleap-cli-test-"));
  mkdirSync(join(h, ".kleap"), { recursive: true });
  writeFileSync(join(h, ".kleap", "config.json"), JSON.stringify(cfg));
  return h;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    SEEN.push(`${req.method} ${path}`);
    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
      return send(res, 401, { error: { code: "UNAUTHORIZED", message: "Missing Authorization header" } });
    }
    const token = auth.slice(7);
    if (token === "bad_key") {
      return send(res, 401, { error: { code: "UNAUTHORIZED", message: "Invalid or revoked API key" } });
    }

    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {}

    let m;

    if (req.method === "GET" && path === "/api/v1/apps/resolve") {
      const q = url.searchParams.get("q");
      if (q === "missing-app") {
        return send(res, 404, { error: { code: "NOT_FOUND", message: "No app matches that address" } });
      }
      return send(res, 200, {
        app_id: 42,
        name: "Bakery",
        slug: "bakery",
        production_url: "https://bakery.kleap.io",
        preview_url: null,
        matched: q,
      });
    }

    if (req.method === "GET" && path === "/api/v1/apps") {
      return send(res, 200, {
        apps: [
          { id: 42, name: "Bakery", production_url: "https://bakery.kleap.io" },
          { id: 43, name: "Draft", production_url: null },
        ],
        pagination: { total: 2, limit: 50, offset: 0, has_more: false },
      });
    }

    if (req.method === "POST" && path === "/api/v1/apps") {
      const failing = /FAIL_TASK/.test(body.prompt || "");
      const pending = /PENDING_DEPLOY/.test(body.prompt || "");
      const taskId = failing ? "task_fail_1" : pending ? "task_pending_1" : "task_create_1";
      return send(res, 201, {
        task_id: taskId,
        app_id: 99,
        chat_id: "chat_1",
        build_url: `https://kleap.co/build/${taskId}`,
        poll_url: `/api/v1/tasks/${taskId}`,
      });
    }

    if (req.method === "POST" && (m = path.match(/^\/api\/v1\/apps\/(\d+)\/messages$/))) {
      const failing = /FAIL_TASK/.test(body.message || "");
      const taskId = failing ? "task_fail_1" : "task_edit_1";
      return send(res, 202, {
        task_id: taskId,
        message_id: "msg_1",
        preview_url: null,
        poll_url: `/api/v1/tasks/${taskId}`,
      });
    }

    if (req.method === "GET" && (m = path.match(/^\/api\/v1\/tasks\/([^/]+)$/))) {
      const id = m[1];
      if (id === "task_fail_1") {
        return send(res, 200, {
          task_id: id,
          type: "modify",
          status: "failed",
          error: { code: "TASK_FAILED", message: "generation error: model refused" },
        });
      }
      if (id === "task_pending_1") {
        return send(res, 200, {
          task_id: id,
          type: "create",
          status: "completed",
          app_id: 99,
          result: { production_url: null, deployment_status: "pending" },
        });
      }
      return send(res, 200, {
        task_id: id,
        type: id.includes("create") ? "create" : "modify",
        status: "completed",
        app_id: 99,
        result: { production_url: "https://freshbakery.kleap.io", deployment_status: "not_applicable" },
      });
    }

    if (req.method === "GET" && (m = path.match(/^\/api\/v1\/apps\/(\d+)$/))) {
      return send(res, 200, {
        id: Number(m[1]),
        name: "Bakery",
        slug: "bakery",
        production_url: "https://bakery.kleap.io",
        visibility: "personal",
      });
    }

    if (req.method === "POST" && (m = path.match(/^\/api\/v1\/apps\/(\d+)\/publish$/))) {
      return send(res, 202, {
        id: Number(m[1]),
        slug: "bakery",
        status: "deploying",
        deploy_key: "dk_1",
        poll_url: `/api/v1/apps/${m[1]}/publish?deploy_key=dk_1`,
        message: "Deployment started.",
      });
    }
    if (req.method === "GET" && (m = path.match(/^\/api\/v1\/apps\/(\d+)\/publish$/))) {
      return send(res, 200, {
        id: Number(m[1]),
        slug: "bakery",
        production_url: "https://bakery.kleap.io",
        status: "published",
        published_at: new Date().toISOString(),
      });
    }

    if (req.method === "POST" && path === "/api/v1/domains/search") {
      return send(res, 200, {
        results: [
          { domain: "mybakery.com", status: "free", price: 12.99, currency: "USD" },
          { domain: "mybakery.io", status: "active", price: 0, currency: "USD" },
        ],
      });
    }
    if (req.method === "POST" && path === "/api/v1/domains/connect") {
      return send(res, 200, {
        status: "pending_dns",
        domain: "mybakery.com",
        dns_config: {
          records: [
            { type: "A", name: "@", value: "178.104.71.55" },
            { type: "A", name: "www", value: "178.104.71.55" },
          ],
          note: "Point these A records at your registrar.",
        },
      });
    }

    if (req.method === "GET" && (m = path.match(/^\/api\/v1\/apps\/(\d+)\/screenshot$/))) {
      return send(res, 200, {
        image_url: "https://cdn.kleap.co/shots/99.png",
        width: 1280,
        height: 720,
        captured_at: new Date().toISOString(),
        cached: false,
      });
    }

    send(res, 404, { error: { code: "NOT_FOUND", message: `no mock route for ${req.method} ${path}` } });
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE_URL = `http://127.0.0.1:${server.address().port}`;

// IMPORTANT: this process also hosts the mock HTTP server the child talks to,
// so the child must be spawned ASYNCHRONOUSLY (node:child_process `spawn`).
// Using the synchronous `spawnSync` here would block this process's event
// loop until the child exits — but the child can't get an HTTP response
// until that same event loop is free to run the mock server's callback.
// That's a guaranteed deadlock, not a network/sandbox issue.
function run(args, { key = "test_key", home = HOME } = {}) {
  const env = { PATH: process.env.PATH, HOME: home, KLEAP_API_URL: BASE_URL };
  if (key) env.KLEAP_API_KEY = key;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL — ${name}`);
    console.error(`    ${e?.stack || e}`);
  }
}

console.log("kleap create");
await test("creates, polls to completion, prints one line with the live URL", async () => {
  const r = await run(["create", "a", "bakery", "site"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ created app 99 — https://freshbakery.kleap.io");
});
await test("--json prints structured output including app_id/task_id/url", async () => {
  const r = await run(["create", "a bakery site", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.app_id, 99);
  assert.equal(obj.task_id, "task_create_1");
  assert.equal(obj.url, "https://freshbakery.kleap.io");
});
await test("--no-wait returns immediately without polling", async () => {
  const r = await run(["create", "a bakery site", "--no-wait"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^… creating app 99 \(task task_create_1\)/);
});
await test("no prompt → usage error on stderr, exit 1", async () => {
  const r = await run(["create"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: kleap create/);
});
await test("a task that fails surfaces the task's error code + message, exit 1", async () => {
  const r = await run(["create", "FAIL_TASK please"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TASK_FAILED/);
  assert.match(r.stderr, /model refused/);
});
await test("null production_url on completion falls back to polling GET /apps/:id", async () => {
  const r = await run(["create", "PENDING_DEPLOY site"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ created app 99 — https://bakery.kleap.io");
});

console.log("kleap edit");
await test("resolves a numeric app id and edits it", async () => {
  const r = await run(["edit", "42", "add a footer"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ edited app 42 — https://freshbakery.kleap.io");
});
await test("missing prompt → usage error", async () => {
  const r = await run(["edit", "42"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: kleap edit/);
});

console.log("kleap status");
await test("prints one-line status by numeric app id", async () => {
  const r = await run(["status", "42"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ Bakery (42) — live: https://bakery.kleap.io");
});
await test("resolves a slug/domain via /apps/resolve first", async () => {
  const r = await run(["status", "bakery"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ Bakery (42) — live: https://bakery.kleap.io");
});
await test("an address that matches no owned app → exit 1, actionable", async () => {
  const r = await run(["status", "missing-app"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗/);
});

console.log("kleap list");
await test("prints one tab-separated row per app", async () => {
  const r = await run(["list"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), [
    "42\tBakery\thttps://bakery.kleap.io",
    "43\tDraft\t-",
  ]);
});

console.log("kleap publish");
await test("starts a deploy and confirms it live", async () => {
  const r = await run(["publish", "42"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ published https://bakery.kleap.io");
});

console.log("kleap domains");
await test("search prints only available (status=free) domains", async () => {
  const r = await run(["domains", "search", "mybakery"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["mybakery.com\t12.99 USD"]);
});
await test("connect reports the apex A record to set", async () => {
  const r = await run(["domains", "connect", "mybakery.com", "42"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout.trim(),
    "✓ mybakery.com pending DNS — point A @ to 178.104.71.55, propagation 5-60min",
  );
});
await test("missing subcommand → usage error", async () => {
  const r = await run(["domains"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: kleap domains/);
});

console.log("kleap screenshot");
await test("prints the captured image URL", async () => {
  const r = await run(["screenshot", "42"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ https://cdn.kleap.co/shots/99.png");
});

console.log("auth");
await test("no credentials anywhere → exit 1 with an actionable message", async () => {
  const r = await run(["status", "42"], { key: null, home: mkdtempSync(join(tmpdir(), "kleap-cli-test-")) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not signed in/);
});
await test("server rejects the key (bad_key) → clean one-line error, not a stack trace", async () => {
  const r = await run(["status", "42"], { key: "bad_key" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗/);
  assert.match(r.stderr, /401|UNAUTHORIZED/);
});
await test("`kleap auth key` stores a key that a later command picks up with no env var", async () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), "kleap-cli-test-"));
  const save = await run(["auth", "key", "kleap_live_sk_stored_via_cli"], { key: null, home: isolatedHome });
  assert.equal(save.status, 0, save.stderr);
  const status = await run(["status", "42"], { key: null, home: isolatedHome });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.trim(), "✓ Bakery (42) — live: https://bakery.kleap.io");
});

console.log("origin binding (SECURITY regression: KLEAP_API_URL must not exfiltrate stored OAuth tokens)");
await test("stored kleap.co OAuth + KLEAP_API_URL=mock → refused, ZERO requests sent, JSON error, exit 1", async () => {
  const home = homeWithConfig({
    oauth: {
      client_id: "c1",
      access_token: "kleap_oauth_SECRET_DO_NOT_LEAK",
      refresh_token: null,
      expires_at: Date.now() + 3600_000, // valid — would be sent if not refused
      api_url: "https://kleap.co",
    },
  });
  const before = SEEN.length;
  const r = await run(["status", "42", "--json"], { key: null, home });
  assert.equal(r.status, 1);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.error.code, "CREDENTIAL_ORIGIN_MISMATCH");
  assert.match(obj.error.message, /bound to https:\/\/kleap\.co/);
  assert.match(obj.error.message, /KLEAP_API_KEY|auth key/); // actionable remedy
  assert.equal(SEEN.length, before, `mock received requests: ${SEEN.slice(before).join(", ")}`);
});
await test("EXPIRED stored OAuth + refresh_token + KLEAP_API_URL=mock → refresh_token NEVER posted to the override", async () => {
  const home = homeWithConfig({
    oauth: {
      client_id: "c1",
      access_token: "kleap_oauth_stale",
      refresh_token: "kleap_refresh_LONG_LIVED_SECRET",
      expires_at: Date.now() - 3600_000, // expired — would trigger a refresh POST if reached
      api_url: "https://kleap.co",
    },
  });
  const before = SEEN.length;
  const r = await run(["status", "42", "--json"], { key: null, home });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout.trim()).error.code, "CREDENTIAL_ORIGIN_MISMATCH");
  const newReqs = SEEN.slice(before);
  assert.equal(newReqs.length, 0, `mock received: ${newReqs.join(", ")}`);
  assert.ok(!newReqs.some((p) => p.includes("/api/oauth/token")), "refresh_token was posted to the override host");
});
await test("explicit KLEAP_API_KEY env still works with a custom KLEAP_API_URL despite a mismatched stored OAuth", async () => {
  const home = homeWithConfig({
    oauth: { client_id: "c1", access_token: "kleap_oauth_x", expires_at: Date.now() + 3600_000, api_url: "https://kleap.co" },
  });
  const r = await run(["status", "42"], { key: "test_key", home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ Bakery (42) — live: https://bakery.kleap.io");
});
await test("stored `auth key` secret still works with a custom KLEAP_API_URL (explicit-secret trust model)", async () => {
  const home = homeWithConfig({
    oauth: { client_id: "c1", access_token: "kleap_oauth_x", expires_at: Date.now() + 3600_000, api_url: "https://kleap.co" },
    apiKey: "kleap_live_sk_explicitly_stored",
  });
  const r = await run(["status", "42"], { key: null, home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ Bakery (42) — live: https://bakery.kleap.io");
});
await test("MCP boot path also refuses a mismatched stored OAuth cleanly (no unhandled rejection)", async () => {
  const home = homeWithConfig({
    oauth: { client_id: "c1", access_token: "kleap_oauth_x", expires_at: Date.now() + 3600_000, api_url: "https://kleap.co" },
  });
  const before = SEEN.length;
  const r = await run([], { key: null, home }); // no args → MCP server path
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bound to https:\/\/kleap\.co/);
  assert.ok(!r.stderr.includes("UnhandledPromiseRejection"), "boot threw an unhandled rejection");
  assert.equal(SEEN.length, before);
});

console.log("backward compat (1.1.2: any flag argv boots the MCP server)");
await test("first arg starting with '-' falls through to the MCP server, not unknown-command", async () => {
  const r = await run(["--stdio"], { key: null, home: mkdtempSync(join(tmpdir(), "kleap-cli-test-")) });
  assert.equal(r.status, 1); // exits via the MCP "Not signed in" path — proving fall-through
  assert.match(r.stderr, /\[kleap-mcp\] Not signed in/);
  assert.ok(!r.stderr.includes("unknown command"), "flag was treated as an unknown command");
});

console.log("auth logout removes the credential file");
await test("logout deletes ~/.kleap/config.json entirely; next call is not signed in", async () => {
  const home = homeWithConfig({ apiKey: "kleap_live_sk_to_revoke" });
  const out = await run(["auth", "logout"], { key: null, home });
  assert.equal(out.status, 0, out.stderr);
  const status = await run(["auth", "status"], { key: null, home });
  assert.equal(status.status, 1);
  assert.match(status.stderr, /not signed in/);
});

console.log("--json on error paths (regression: not-signed-in was plain text even with --json)");
await test("status --json with no credentials → parseable JSON error, code=not_authenticated, exit 1", async () => {
  const r = await run(["status", "42", "--json"], { key: null, home: mkdtempSync(join(tmpdir(), "kleap-cli-test-")) });
  assert.equal(r.status, 1);
  const obj = JSON.parse(r.stdout.trim()); // must not throw — the whole point
  assert.equal(obj.error.code, "not_authenticated");
  assert.match(obj.error.message, /not signed in/);
  assert.equal(r.stderr.trim(), ""); // JSON mode: nothing stray on stderr
});
await test("create --json with no prompt → parseable JSON usage error, exit 1", async () => {
  const r = await run(["create", "--json"]);
  assert.equal(r.status, 1);
  const obj = JSON.parse(r.stdout.trim());
  assert.match(obj.error.message, /usage: kleap create/);
});
await test("status --json with a rejected key → parseable JSON API error, exit 1", async () => {
  const r = await run(["status", "42", "--json"], { key: "bad_key" });
  assert.equal(r.status, 1);
  const obj = JSON.parse(r.stdout.trim());
  assert.match(obj.error.message, /401|UNAUTHORIZED/);
});
await test("unknown command with --json → parseable JSON error, code=unknown_command, exit 1", async () => {
  const r = await run(["bogus-command", "--json"], { key: null });
  assert.equal(r.status, 1);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.error.code, "unknown_command");
  assert.match(obj.error.message, /unknown command: bogus-command/);
});
await test("auth status --json with no credentials → parseable JSON, code=not_authenticated", async () => {
  const r = await run(["auth", "status", "--json"], { key: null, home: mkdtempSync(join(tmpdir(), "kleap-cli-test-")) });
  assert.equal(r.status, 1);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.error.code, "not_authenticated");
});

console.log("top-level");
await test("--help prints usage and exits 0", async () => {
  const r = await run(["--help"], { key: null });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /kleap create/);
});
await test("an unknown command exits 1 with usage, does not hang trying to speak MCP", async () => {
  const r = await run(["bogus-command"], { key: null });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command: bogus-command/);
});

server.close();

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nCLI TESTS OK");
