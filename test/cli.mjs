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
// Last request body + query per "METHOD /path", for asserting what was sent.
const LAST = {};

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
    LAST[`${req.method} ${path}`] = { body, query: Object.fromEntries(url.searchParams) };

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

    if (req.method === "POST" && path === "/api/v1/apps/4242/publish") {
      return send(res, 409, { error: { code: "CONFLICT", message: "A deployment is already running", details: { deploy_key: "dk_running" } } });
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

    // ── 2.1.0 routes ──────────────────────────────────────────────────────

    if (req.method === "GET" && path === "/api/v1/account/credits") {
      return send(res, 200, { credits_balance: 624.6, is_paid: false });
    }
    if ((m = path.match(/^\/api\/v1\/apps\/(\d+)\/files$/))) {
      if (req.method === "GET" && url.searchParams.get("paths")) {
        const paths = url.searchParams.get("paths").split(",");
        const known = {
          "src/pages/index.astro": { content: "<h1>Hi</h1>\n", type: "text" },
          "src/data/site.json": { content: '{"a":1}', type: "text" },
          "public/logo.png": { content: "iVBORw0KGgo=", type: "binary" },
        };
        return send(res, 200, {
          files: paths.filter((p) => known[p]).map((p) => ({ path: p, ...known[p], bytes: known[p].content.length })),
          missing: paths.filter((p) => !known[p]),
        });
      }
      if (req.method === "GET") {
        return send(res, 200, {
          files: [
            { path: "src/pages/index.astro", type: "text", updated_at: "2026-09-25T00:00:00Z" },
            { path: "public/logo.png", type: "binary", updated_at: "2026-09-25T00:00:00Z" },
          ],
          count: 2,
        });
      }
      if (req.method === "PUT") return send(res, 200, { written: body.files.length, message: "Files written." });
      if (req.method === "PATCH") {
        if (body.edits?.[0]?.old_string === "NOPE") {
          return send(res, 422, { error: { code: "EDIT_NOT_FOUND", message: "old_string not found in src/pages/index.astro", details: {}, request_id: "req_e" } });
        }
        return send(res, 200, { edited: [{ path: body.edits[0].path, replacements: body.edits[0].replace_all ? 3 : 1 }], replacements: body.edits[0].replace_all ? 3 : 1 });
      }
      if (req.method === "DELETE") {
        return send(res, 200, { deleted: body.paths.filter((p) => p !== "ghost.astro"), message: "Files deleted." });
      }
    }
    if (req.method === "GET" && (m = path.match(/^\/api\/v1\/apps\/(\d+)\/forms$/))) {
      return send(res, 200, {
        app_id: Number(m[1]),
        submissions: [
          { id: "sub_2", submitted_at: "2026-09-25T10:00:00Z", data: { name: "Ada", email: "ada@example.com" }, ip_address: null, user_agent: null },
          { id: "sub_1", submitted_at: "2026-09-24T09:00:00Z", data: { name: "Bob", message: "Hello\nthere" }, ip_address: null, user_agent: null },
        ],
        count: 2,
        limit: Number(url.searchParams.get("limit") || 20),
      });
    }
    if (req.method === "GET" && (m = path.match(/^\/api\/v1\/apps\/(\d+)\/analytics$/))) {
      return send(res, 200, {
        app_id: Number(m[1]),
        period: url.searchParams.get("period") || "7d",
        configured: true,
        visitors: 12,
        pageviews: 30,
        top_pages: [{ path: "/", pageviews: 20 }, { path: "/contact", pageviews: 10 }],
        referrers: [],
      });
    }
    if (req.method === "GET" && (m = path.match(/^\/api\/v1\/apps\/(\d+)\/search-console$/))) {
      return send(res, 200, { app_id: 42, period: "28d", clicks: 0, impressions: 0, ctr: 0, position: 0, connected: false, site_selected: false, message: "Google Search Console isn't connected for this site." });
    }
    if (req.method === "POST" && (m = path.match(/^\/api\/v1\/apps\/(\d+)\/search-console\/connect$/))) {
      return send(res, 200, { app_id: 42, connected: false, site_selected: false, custom_domain: "mybakery.com", consent_url: "https://accounts.google.com/o/oauth2/auth?x=1", expires_in_minutes: 60 });
    }
    if (req.method === "GET" && (m = path.match(/^\/api\/v1\/apps\/(\d+)\/messages$/))) {
      return send(res, 200, { messages: [
        { id: 1, role: "user", content: "a bakery site", created_at: "2026-09-25T00:00:00Z" },
        { id: 2, role: "assistant", content: "Done.\nYour site is live.", created_at: "2026-09-25T00:01:00Z" },
      ] });
    }
    if (req.method === "PATCH" && (m = path.match(/^\/api\/v1\/apps\/(\d+)$/))) {
      return send(res, 200, { id: Number(m[1]), name: body.name, slug: "bakery" });
    }
    if (req.method === "POST" && (m = path.match(/^\/api\/v1\/apps\/(\d+)\/wake$/))) {
      return send(res, 200, { success: true, preview_url: "https://3000-sbx.preview.kleap.co", message: "Sandbox is waking up." });
    }
    if (req.method === "POST" && (m = path.match(/^\/api\/v1\/apps\/(\d+)\/generate-image$/))) {
      return send(res, 200, { path: body.path, bytes: 51200, model: body.hd ? "flux-2-dev" : "flux-2-klein-9b", size: "768x768" });
    }
    if ((m = path.match(/^\/api\/v1\/tasks\/([^/]+)\/retry$/)) && req.method === "POST") {
      return send(res, 201, { task_id: "task_retry_1", app_id: 99, poll_url: "/api/v1/tasks/task_retry_1" });
    }
    // Database. App 77 has no database; app 78's key lacks the scope.
    if ((m = path.match(/^\/api\/v1\/apps\/(\d+)\/database(\/.*)?$/))) {
      const id = Number(m[1]);
      const rest = m[2] || "";
      if (id === 77) {
        return send(res, 409, { error: { code: "DATABASE_NOT_PROVISIONED", message: "This app has no database", details: {}, request_id: "req_db" } });
      }
      if (id === 78) {
        return send(res, 403, { error: { code: "INSUFFICIENT_SCOPE", message: "This API key lacks the database:write scope", details: { required_scope: "database:write" }, request_id: "req_sc" } });
      }
      if (req.method === "GET" && rest === "") {
        return send(res, 200, { provisioned: true, tables: [
          { name: "leads", row_count: 2, columns: [
            { name: "id", type: "integer", nullable: false, default: null, primary_key: true },
            { name: "email", type: "text", nullable: false, default: null, primary_key: false },
            { name: "status", type: "text", nullable: true, default: "'new'", primary_key: false },
          ] },
        ] });
      }
      let t;
      if ((t = rest.match(/^\/tables\/([^/]+)\/rows$/))) {
        const table = decodeURIComponent(t[1]);
        if (req.method === "GET") {
          const lim = Number(url.searchParams.get("limit") || 100);
          const rows = [{ id: 1, email: "a@x.co", status: "new" }, { id: 2, email: "b@x.co", status: "new" }].slice(0, lim);
          return send(res, 200, { table, rows, limit: lim, offset: Number(url.searchParams.get("offset") || 0), has_more: lim < 2 });
        }
        if (req.method === "POST") return send(res, 200, { table, inserted: body.rows.length, rows: body.rows.map((r, i) => ({ id: 10 + i, ...r })) });
        if (req.method === "PATCH") {
          if (!body.where || !Object.keys(body.where).length) return send(res, 400, { error: { code: "VALIDATION_ERROR", message: "where is required" } });
          return send(res, 200, { table, updated: 1, rows: [{ id: 1, ...body.set }] });
        }
        if (req.method === "DELETE") {
          if (!body.where || !Object.keys(body.where).length) return send(res, 400, { error: { code: "VALIDATION_ERROR", message: "where is required" } });
          return send(res, 200, { table, deleted: 1 });
        }
      }
      if (req.method === "POST" && rest === "/query") {
        if (/^\s*explain/i.test(body.sql)) {
          return send(res, 400, { error: { code: "UNSUPPORTED_STATEMENT", message: "EXPLAIN is not available through the API" } });
        }
        if (/big_table/.test(body.sql)) {
          return send(res, 200, { command: "SELECT", row_count: 500, rows: [{ id: 1 }], truncated: true });
        }
        if (/create table/i.test(body.sql) && !/row level security/i.test(body.sql)) {
          return send(res, 422, { error: { code: "RLS_REQUIRED", message: "Public table without RLS", details: { tables: ["notes"] } } });
        }
        return send(res, 200, { command: "SELECT", row_count: 1, rows: [{ n: body.params?.[0] ?? 1 }] });
      }
    }
    // Domains
    if (req.method === "POST" && path === "/api/v1/domains/checkout") {
      if (body.domain === "taken.com") {
        return send(res, 409, { error: { code: "DOMAIN_UNAVAILABLE", message: "taken.com is not available" } });
      }
      return send(res, 201, {
        checkout_url: "https://checkout.stripe.com/c/pay/cs_test_1",
        domain: body.domain,
        years: body.years || 1,
        price: 14.99,
        currency: "USD",
        expires_at: "2026-09-26T00:00:00Z",
      });
    }
    if (req.method === "POST" && path === "/api/v1/domains/purchase") {
      return send(res, 500, { error: { code: "FORBIDDEN_IN_TESTS", message: "purchase must never be called" } });
    }
    if (req.method === "GET" && (m = path.match(/^\/api\/v1\/domains\/([^/]+)\/check$/))) {
      const d = decodeURIComponent(m[1]);
      if (d === "unknown.com") return send(res, 404, { error: { code: "NOT_FOUND", message: "Domain not registered" } });
      if (d === "live.com") return send(res, 200, { status: "active", domain: d, url: `https://${d}`, tls: "provisioning" });
      return send(res, 200, { status: "pending_dns", domain: d, message: "A record not found yet. DNS propagation can take 5–60 min." });
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
function run(args, { key = "test_key", home = HOME, input } = {}) {
  const env = { PATH: process.env.PATH, HOME: home, KLEAP_API_URL: BASE_URL };
  if (key) env.KLEAP_API_KEY = key;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: root, env });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
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

// ── 2.1.0 commands ───────────────────────────────────────────────────────────
const TMP = mkdtempSync(join(tmpdir(), "kleap-cli-files-"));
const json = (r) => JSON.parse(r.stdout.trim());

console.log("kleap credits");
await test("prints balance + plan", async () => {
  const r = await run(["credits"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ 624.6 credits — free plan");
});
await test("--json returns the API object", async () => {
  const r = await run(["credits", "--json"]);
  assert.deepEqual(json(r), { credits_balance: 624.6, is_paid: false });
});

console.log("kleap files");
await test("ls prints one path per line (resolving a slug first)", async () => {
  const r = await run(["files", "ls", "bakery"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["src/pages/index.astro", "public/logo.png"]);
});
await test("cat of ONE text file prints its raw content", async () => {
  const r = await run(["files", "cat", "42", "src/pages/index.astro"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "<h1>Hi</h1>\n");
});
await test("cat of several files prints ==> headers; binaries are not dumped", async () => {
  const r = await run(["files", "cat", "42", "src/data/site.json", "public/logo.png"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /==> src\/data\/site.json <==\n\{"a":1\}/);
  assert.match(r.stdout, /==> public\/logo.png <==\n\(binary file/);
});
await test("cat of a missing path → exit 1 naming it", async () => {
  const r = await run(["files", "cat", "42", "src/pages/index.astro", "nope.astro"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found: nope.astro/);
});
await test("cat --json returns files + missing", async () => {
  const r = await run(["files", "cat", "42", "src/pages/index.astro", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).files[0].path, "src/pages/index.astro");
});
await test("write --content sends UTF-8 text (no encoding field)", async () => {
  const r = await run(["files", "write", "42", "src/pages/about.astro", "--content", "<h1>About</h1>"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ wrote src\/pages\/about.astro \(14 bytes\) to app 42 — deploy it: kleap publish 42/);
  assert.deepEqual(LAST["PUT /api/v1/apps/42/files"].body.files, [{ path: "src/pages/about.astro", content: "<h1>About</h1>" }]);
});
await test("write --file of a .png sends base64 automatically", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const local = join(TMP, "logo.png");
  writeFileSync(local, png);
  const r = await run(["files", "write", "42", "public/logo.png", "--file", local]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /base64/);
  const f = LAST["PUT /api/v1/apps/42/files"].body.files[0];
  assert.equal(f.encoding, "base64");
  assert.deepEqual(Buffer.from(f.content, "base64"), png);
});
await test("write --stdin reads the content from stdin", async () => {
  const r = await run(["files", "write", "42", "src/data/x.json", "--stdin"], { input: '{"from":"stdin"}' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(LAST["PUT /api/v1/apps/42/files"].body.files[0].content, '{"from":"stdin"}');
});
await test("write refuses >512 KB locally, before any request", async () => {
  const local = join(TMP, "big.txt");
  writeFileSync(local, Buffer.alloc(600 * 1024, 97));
  const r = await run(["files", "write", "42", "src/big.txt", "--file", local, "--json"]);
  assert.equal(r.status, 1);
  assert.equal(json(r).error.code, "FILE_TOO_LARGE");
});
await test("write with no content source → usage error", async () => {
  const r = await run(["files", "write", "42", "src/x.astro"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exactly one of --file, --stdin, --content/);
});
await test("edit sends old_string/new_string/replace_all", async () => {
  const r = await run(["files", "edit", "42", "src/pages/index.astro", "--find", "Hi", "--replace", "Hello", "--all"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ edited src\/pages\/index.astro \(3 replacements\)/);
  assert.deepEqual(LAST["PATCH /api/v1/apps/42/files"].body.edits, [
    { path: "src/pages/index.astro", old_string: "Hi", new_string: "Hello", replace_all: true },
  ]);
});
await test("edit accepts an empty --replace (deletion of the matched text)", async () => {
  const r = await run(["files", "edit", "42", "src/pages/index.astro", "--find", "Hi", "--replace", ""]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(LAST["PATCH /api/v1/apps/42/files"].body.edits[0].new_string, "");
});
await test("edit API error shows CODE: message", async () => {
  const r = await run(["files", "edit", "42", "src/pages/index.astro", "--find", "NOPE", "--replace", "x"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ EDIT_NOT_FOUND: old_string not found/);
});
await test("rm deletes and reminds to publish", async () => {
  const r = await run(["files", "rm", "42", "src/pages/old.astro", "ghost.astro"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ deleted src\/pages\/old.astro from app 42/);
  assert.deepEqual(LAST["DELETE /api/v1/apps/42/files"].body, { paths: ["src/pages/old.astro", "ghost.astro"] });
});
await test("unknown files subcommand → usage", async () => {
  const r = await run(["files", "mv", "42"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: kleap files <ls\|cat\|write\|edit\|rm>/);
});

console.log("kleap forms / analytics / search-console / messages");
await test("forms prints one line per submission, newest first", async () => {
  const r = await run(["forms", "42"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "2026-09-25T10:00:00Z\tname=Ada · email=ada@example.com");
  assert.equal(lines[1], "2026-09-24T09:00:00Z\tname=Bob · message=Hello there");
});
await test("forms --json is flattened (data fields + submission_id/submitted_at/app_id)", async () => {
  const r = await run(["forms", "42", "--since", "2026-09-01", "--limit", "5", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const obj = json(r);
  assert.equal(obj.count, 2);
  assert.deepEqual(obj.submissions[0], { name: "Ada", email: "ada@example.com", submission_id: "sub_2", submitted_at: "2026-09-25T10:00:00Z", app_id: 42 });
  assert.equal(LAST["GET /api/v1/apps/42/forms"].query.since, "2026-09-01T00:00:00.000Z");
  assert.equal(LAST["GET /api/v1/apps/42/forms"].query.limit, "5");
});
await test("forms --since garbage → usage error, no request", async () => {
  const r = await run(["forms", "42", "--since", "yesterday-ish"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ISO 8601/);
});
await test("analytics one-liner with top pages, --period forwarded", async () => {
  const r = await run(["analytics", "42", "--period", "30d"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ 30d: 12 visitors, 30 pageviews — top: / (20), /contact (10)");
});
await test("analytics rejects an unknown period", async () => {
  const r = await run(["analytics", "42", "--period", "1y"]);
  assert.equal(r.status, 1);
});
await test("search-console reports not connected + the next step", async () => {
  const r = await run(["search-console", "42"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not connected/);
});
await test("search-console connect prints the consent link for the user", async () => {
  const r = await run(["search-console", "connect", "42"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /user must open this link.*https:\/\/accounts.google.com/);
});
await test("messages prints role + one-line content", async () => {
  const r = await run(["messages", "42"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), [
    "2026-09-25T00:00:00Z\tuser\ta bakery site",
    "2026-09-25T00:01:00Z\tassistant\tDone. Your site is live.",
  ]);
});

console.log("kleap rename / wake / image");
await test("rename joins the words of the new name", async () => {
  const r = await run(["rename", "42", "Pain", "&", "Sel"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '✓ renamed app 42 to "Pain & Sel" (URL unchanged)');
});
await test("wake prints the preview URL", async () => {
  const r = await run(["wake", "42"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /https:\/\/3000-sbx.preview.kleap.co/);
});
await test("image sends path/prompt/hd and reminds to publish", async () => {
  const r = await run(["image", "42", "public/hero.webp", "a warm bakery", "at dawn", "--hd"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ generated public/hero.webp (50 KB) — deploy it: kleap publish 42");
  assert.deepEqual(LAST["POST /api/v1/apps/42/generate-image"].body, { path: "public/hero.webp", prompt: "a warm bakery at dawn", hd: true });
});
await test("image refuses a path outside public/ or a wrong extension", async () => {
  const r = await run(["image", "42", "src/hero.gif", "x"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must start with public\//);
});

console.log("kleap task");
await test("task <id> → one-line completed status", async () => {
  const r = await run(["task", "task_create_1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ task task_create_1 completed — app 99 https://freshbakery.kleap.io");
});
await test("task <failed id> → exit 1 with code + the retry command", async () => {
  const r = await run(["task", "task_fail_1", "--json"]);
  assert.equal(r.status, 1);
  const e = json(r).error;
  assert.equal(e.code, "TASK_FAILED");
  assert.match(e.message, /kleap task retry task_fail_1/);
  assert.equal(e.task.status, "failed");
});
await test("task retry <id> → new task id", async () => {
  const r = await run(["task", "retry", "task_fail_1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /retrying as task task_retry_1/);
});
await test("task retry <id> --wait follows the NEW task to completion", async () => {
  const r = await run(["task", "retry", "task_fail_1", "--wait", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).task_id, "task_retry_1");
  assert.equal(json(r).status, "completed");
});

console.log("kleap db");
await test("schema prints one line per table", async () => {
  const r = await run(["db", "schema", "42"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "leads (~2 rows): id integer pk, email text not null, status text");
});
await test("rows forwards where/limit/order and prints JSON lines", async () => {
  const r = await run(["db", "rows", "42", "leads", "--where", '{"status":"new"}', "--limit", "1", "--order-by", "id", "--order", "desc"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.deepEqual(JSON.parse(lines[0]), { id: 1, email: "a@x.co", status: "new" });
  assert.match(lines[1], /more rows — next page: --offset 1/);
  const q = LAST["GET /api/v1/apps/42/database/tables/leads/rows"].query;
  assert.deepEqual(q, { limit: "1", order_by: "id", order: "desc", where: '{"status":"new"}' });
});
await test("rows with invalid --where JSON → usage error naming the flag", async () => {
  const r = await run(["db", "rows", "42", "leads", "--where", "{status:new}", "--json"]);
  assert.equal(r.status, 1);
  assert.match(json(r).error.message, /--where is not valid JSON/);
});
await test("insert accepts an object and wraps it in rows[]", async () => {
  const r = await run(["db", "insert", "42", "leads", '{"email":"c@x.co"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ inserted 1 row(s) into leads");
  assert.deepEqual(LAST["POST /api/v1/apps/42/database/tables/leads/rows"].body, { rows: [{ email: "c@x.co" }] });
});
await test("insert --file with an array, chunked at 500 per call", async () => {
  const local = join(TMP, "rows.json");
  writeFileSync(local, JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ email: `u${i}@x.co` }))));
  const before = SEEN.filter((s) => s === "POST /api/v1/apps/42/database/tables/leads/rows").length;
  const r = await run(["db", "insert", "42", "leads", "--file", local, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).inserted, 501);
  const after = SEEN.filter((s) => s === "POST /api/v1/apps/42/database/tables/leads/rows").length;
  assert.equal(after - before, 2);
});
await test("update sends where + set", async () => {
  const r = await run(["db", "update", "42", "leads", "--where", '{"id":1}', "--set", '{"status":"done"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ updated 1 row(s) in leads");
  assert.deepEqual(LAST["PATCH /api/v1/apps/42/database/tables/leads/rows"].body, { where: { id: 1 }, set: { status: "done" } });
});
await test("update/delete WITHOUT --where are refused locally (never touch every row)", async () => {
  const before = SEEN.length;
  const r1 = await run(["db", "update", "42", "leads", "--set", '{"status":"x"}']);
  const r2 = await run(["db", "delete", "42", "leads", "--where", "{}"]);
  assert.equal(r1.status, 1);
  assert.equal(r2.status, 1);
  assert.match(r1.stderr, /non-empty where/);
  assert.equal(SEEN.length, before, "no request may be sent");
});
await test("delete sends where and reports the count", async () => {
  const r = await run(["db", "delete", "42", "leads", "--where", '{"id":2}']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ deleted 1 row(s) from leads");
});
await test("sql sends sql + params and prints rows then a summary", async () => {
  const r = await run(["db", "sql", "42", "select $1::int as n", "--params", "[7]"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ['{"n":7}', "✓ SELECT — 1 row(s)"]);
  assert.deepEqual(LAST["POST /api/v1/apps/42/database/query"].body, { sql: "select $1::int as n", params: [7] });
});
await test("RLS_REQUIRED → CODE: message + actionable hint", async () => {
  const r = await run(["db", "sql", "42", "create table notes (id int)"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ RLS_REQUIRED: Public table without RLS/);
  assert.match(r.stderr, /ENABLE ROW LEVEL SECURITY/);
});
await test("UNSUPPORTED_STATEMENT → code + hint pointing at the row commands", async () => {
  const r = await run(["db", "sql", "42", "EXPLAIN SELECT 1"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ UNSUPPORTED_STATEMENT: EXPLAIN/);
  assert.match(r.stderr, /kleap db rows/);
});
await test("a truncated SQL result says so", async () => {
  const r = await run(["db", "sql", "42", "select * from big_table"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /truncated by the API row cap/);
});
await test("search-console --period is forwarded and validated", async () => {
  const r = await run(["search-console", "42", "--period", "90d"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(LAST["GET /api/v1/apps/42/search-console"].query.period, "90d");
  const bad = await run(["search-console", "42", "--period", "1y"]);
  assert.equal(bad.status, 1);
});
await test("DATABASE_NOT_PROVISIONED → --json error with code + hint", async () => {
  const r = await run(["db", "schema", "77", "--json"]);
  assert.equal(r.status, 1);
  const e = json(r).error;
  assert.equal(e.code, "DATABASE_NOT_PROVISIONED");
  assert.equal(e.status, 409);
  assert.equal(e.request_id, "req_db");
  assert.match(e.hint, /add a database/);
});
await test("INSUFFICIENT_SCOPE → tells the user to create a Full key, keeps details.required_scope", async () => {
  const r = await run(["db", "insert", "78", "leads", '{"a":1}', "--json"]);
  assert.equal(r.status, 1);
  const e = json(r).error;
  assert.equal(e.code, "INSUFFICIENT_SCOPE");
  assert.equal(e.details.required_scope, "database:write");
  assert.match(e.hint, /Full preset/);
});

console.log("kleap domains buy / check");
await test("buy prints the checkout URL and says it is NOT bought", async () => {
  const r = await run(["domains", "buy", "MyBakery.com", "--years", "2", "--app", "bakery"]);
  assert.equal(r.status, 0, r.stderr);
  const [l1, l2] = r.stdout.trim().split("\n");
  assert.equal(l1, "→ checkout for mybakery.com (14.99 USD, 2 years): https://checkout.stripe.com/c/pay/cs_test_1");
  assert.match(l2, /NOT bought yet — the user must open this link and pay/);
  assert.match(l2, /connected to app 42/);
  assert.deepEqual(LAST["POST /api/v1/domains/checkout"].body, { domain: "mybakery.com", years: 2, app_id: 42 });
});
await test("buy --json flags paid:false / requires_user_payment:true", async () => {
  const r = await run(["domains", "buy", "mybakery.com", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const o = json(r);
  assert.equal(o.checkout_url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(o.paid, false);
  assert.equal(o.requires_user_payment, true);
});
await test("buy NEVER calls /domains/purchase", async () => {
  assert.ok(!SEEN.includes("POST /api/v1/domains/purchase"), "the CLI called /domains/purchase");
});
await test("buy of an unavailable domain → exit 1 with the API code", async () => {
  const r = await run(["domains", "buy", "taken.com"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DOMAIN_UNAVAILABLE/);
});
await test("search normalizes a phrase to one label and dots the TLDs", async () => {
  const r = await run(["domains", "search", "Café", "Lumière", "--tlds", "com,.ch"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(LAST["POST /api/v1/domains/search"].body, { query: "cafelumiere", tlds: [".com", ".ch"] });
});
await test("check → active / pending / not registered", async () => {
  const a = await run(["domains", "check", "live.com"]);
  assert.equal(a.stdout.trim(), "✓ live.com active — https://live.com (TLS provisioning)");
  const p = await run(["domains", "check", "mybakery.com"]);
  assert.match(p.stdout, /… mybakery.com pending DNS — A record not found yet/);
  const n = await run(["domains", "check", "unknown.com"]);
  assert.equal(n.status, 1);
  assert.match(n.stderr, /NOT_FOUND: Domain not registered/);
});

console.log("publish follows an already-running deploy (409 CONFLICT)");
await test("CONFLICT reuses details.deploy_key instead of failing", async () => {
  const r = await run(["publish", "4242"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "✓ published https://bakery.kleap.io");
  assert.equal(LAST["GET /api/v1/apps/4242/publish"].query.deploy_key, "dk_running");
});

console.log("MCP stdio server (JSON-RPC against the mock)");
function mcpSession(requests) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME, KLEAP_API_URL: BASE_URL, KLEAP_API_KEY: "test_key" };
    const child = spawn(process.execPath, [BIN], { cwd: root, env });
    let buf = "";
    const out = [];
    const want = requests.filter((r) => r.id != null).length;
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) out.push(JSON.parse(line));
        if (out.filter((o) => o.id != null).length >= want) {
          clearTimeout(timer);
          child.kill();
          resolve(out);
        }
      }
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...r })}\n`);
  });
}
const INIT = [
  { id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
  { method: "notifications/initialized" },
];
const call = (id, name, args) => ({ id, method: "tools/call", params: { name, arguments: args } });
const REMOTE_PARITY = [
  "create_app", "modify_app", "check_task", "retry_task", "publish_app", "get_publish_status",
  "list_apps", "get_app", "find_app", "rename_app", "get_screenshot", "wake_app", "generate_image",
  "list_app_files", "read_files", "write_files", "edit_files", "delete_files",
  "get_form_submissions", "get_analytics", "get_search_console", "connect_search_console", "get_credits",
  "search_domains", "check_domain", "connect_domain", "buy_domain",
  "get_database_schema", "query_database_rows", "insert_database_rows", "update_database_rows",
  "delete_database_rows", "run_database_sql",
];
await test("tools/list exposes exactly the remote-parity tool set (33 tools)", async () => {
  const out = await mcpSession([...INIT, { id: 1, method: "tools/list" }]);
  const names = out.find((o) => o.id === 1).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...REMOTE_PARITY].sort());
});
await test("database + buy_domain + edit_files tools hit the right routes", async () => {
  const out = await mcpSession([
    ...INIT,
    call(1, "query_database_rows", { app_id: 42, table: "leads", where: { status: "new" }, limit: 5 }),
    call(2, "buy_domain", { domain: "mybakery.com", app_id: 42 }),
    call(3, "delete_database_rows", { app_id: 42, table: "leads", where: {} }),
    call(4, "get_database_schema", { app_id: 77 }),
    call(5, "edit_files", { app_id: 42, edits: [{ path: "a.astro", old_string: "x", new_string: "y" }] }),
    call(6, "insert_database_rows", { app_id: "bakery", table: "leads", rows: [{ email: "m@x.co" }] }),
  ]);
  const r = (id) => out.find((o) => o.id === id).result;
  assert.equal(JSON.parse(r(1).content[0].text).table, "leads");
  assert.equal(JSON.parse(r(2).content[0].text).checkout_url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(r(3).isError, true);
  assert.match(r(3).content[0].text, /non-empty where/);
  assert.equal(r(4).isError, true);
  assert.match(r(4).content[0].text, /DATABASE_NOT_PROVISIONED/);
  assert.match(r(4).content[0].text, /Hint: .*add a database/);
  assert.equal(JSON.parse(r(5).content[0].text).replacements, 1);
  assert.equal(JSON.parse(r(6).content[0].text).inserted, 1);
  assert.ok(!SEEN.includes("POST /api/v1/domains/purchase"));
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
