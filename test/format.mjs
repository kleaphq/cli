// Unit tests for lib/format.mjs — pure functions, no network, no process.
// Run: node test/format.mjs
import assert from "node:assert/strict";
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
  oneLine,
  HELP,
} from "../lib/format.mjs";

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL — ${name}`);
    console.error(`    ${e?.message || e}`);
  }
}

console.log("parseArgs");
test("splits positional args from --json", () => {
  const { positional, flags } = parseArgs(["create", "a bakery site", "--json"]);
  assert.deepEqual(positional, ["create", "a bakery site"]);
  assert.equal(flags.json, true);
});
test("consumes the value after --visibility/--webhook/--limit/--q/--tlds", () => {
  const { positional, flags } = parseArgs([
    "42",
    "--visibility",
    "public",
    "--webhook",
    "https://example.com/hook",
    "--limit",
    "10",
    "--q",
    "bakery",
    "--tlds",
    ".com,.io",
  ]);
  assert.deepEqual(positional, ["42"]);
  assert.equal(flags.visibility, "public");
  assert.equal(flags.webhook, "https://example.com/hook");
  assert.equal(flags.limit, "10");
  assert.equal(flags.q, "bakery");
  assert.equal(flags.tlds, ".com,.io");
});
test("--no-wait sets noWait, unknown flags fall through as positional-safe (no crash)", () => {
  const { flags } = parseArgs(["--no-wait"]);
  assert.equal(flags.noWait, true);
});
test("empty argv → empty positional, no flags", () => {
  const { positional, flags } = parseArgs([]);
  assert.deepEqual(positional, []);
  assert.deepEqual(flags, {});
});

console.log("isNumericId");
test("bare integer string is numeric", () => assert.equal(isNumericId("123"), true));
test("slug is not numeric", () => assert.equal(isNumericId("my-bakery"), false));
test("domain is not numeric", () => assert.equal(isNumericId("mysite.kleap.io"), false));
test("undefined is not numeric (no throw)", () => assert.equal(isNumericId(undefined), false));

console.log("formatAppLine / formatListLine / formatDomainLine");
test("formatAppLine — published app", () => {
  const line = formatAppLine({ id: 7, name: "Bakery", production_url: "https://bakery.kleap.io" });
  assert.equal(line, "Bakery (7) — live: https://bakery.kleap.io");
});
test("formatAppLine — unpublished app", () => {
  const line = formatAppLine({ id: 9, name: "Draft", production_url: null });
  assert.equal(line, "Draft (9) — not published");
});
test("formatListLine — tab-separated, dash for missing URL", () => {
  assert.equal(
    formatListLine({ id: 1, name: "A", production_url: "https://a.kleap.io" }),
    "1\tA\thttps://a.kleap.io",
  );
  assert.equal(formatListLine({ id: 2, name: "B", production_url: null }), "2\tB\t-");
});
test("formatDomainLine — includes price+currency when present", () => {
  assert.equal(
    formatDomainLine({ domain: "mybakery.com", status: "free", price: 12.99, currency: "USD" }),
    "mybakery.com\t12.99 USD",
  );
});
test("formatDomainLine — trims trailing tab when price missing", () => {
  assert.equal(formatDomainLine({ domain: "mybakery.io", status: "free" }), "mybakery.io");
});

console.log("findApexARecord");
test("finds the @ A record", () => {
  const dns = { records: [{ type: "A", name: "@", value: "178.104.71.55" }, { type: "A", name: "www", value: "178.104.71.55" }] };
  assert.equal(findApexARecord(dns), "178.104.71.55");
});
test("returns null when missing", () => {
  assert.equal(findApexARecord({ records: [] }), null);
  assert.equal(findApexARecord(undefined), null);
});

console.log("parseArgs (2.1.0 flags)");
test("value flags, --flag=value form, booleans", () => {
  const { positional, flags } = parseArgs([
    "db", "rows", "42", "leads", "--where", '{"a":1}', "--order-by=created_at", "--order", "desc",
    "--all", "--hd", "--wait", "--stdin", "--years", "2", "--app", "bakery", "--replace", "",
  ]);
  assert.deepEqual(positional, ["db", "rows", "42", "leads"]);
  assert.equal(flags.where, '{"a":1}');
  assert.equal(flags.orderBy, "created_at");
  assert.equal(flags.order, "desc");
  assert.equal(flags.all && flags.hd && flags.wait && flags.stdin, true);
  assert.equal(flags.years, "2");
  assert.equal(flags.app, "bakery");
  assert.equal(flags.replace, "");
});
test("a value flag at the very end records an empty string, not undefined", () => {
  assert.equal(parseArgs(["--find"]).flags.find, "");
});

console.log("2.1.0 helpers");
test("isBinaryPath — images/fonts/pdf yes, text and svg no", () => {
  for (const p of ["public/a.png", "public/b.JPG", "public/f.woff2", "public/doc.pdf", "public/v.mp4"]) assert.equal(isBinaryPath(p), true, p);
  for (const p of ["src/pages/index.astro", "public/logo.svg", "src/data/x.json", "README", "public/.png.txt"]) assert.equal(isBinaryPath(p), false, p);
});
test("normalizeDomainQuery — one lowercase label, accents and spaces stripped", () => {
  assert.equal(normalizeDomainQuery("  Café Lumière "), "cafelumiere");
});
test("normalizeTlds — adds dots, drops blanks", () => {
  assert.deepEqual(normalizeTlds("com, .ch,,io"), [".com", ".ch", ".io"]);
  assert.equal(normalizeTlds(""), undefined);
});
test("flattenSubmission — data at top level + ids", () => {
  assert.deepEqual(flattenSubmission({ id: "s1", submitted_at: "t", data: { email: "a@b.c" } }, "42"), {
    email: "a@b.c", submission_id: "s1", submitted_at: "t", app_id: 42,
  });
});
test("formatSubmissionLine — collapses newlines", () => {
  assert.equal(formatSubmissionLine({ submitted_at: "t", data: { msg: "a\nb" } }), "t\tmsg=a b");
});
test("formatAnalytics — not configured shows the API message", () => {
  const s = formatAnalytics({ period: "7d", configured: false, visitors: 0, pageviews: 0, message: "publish first" });
  assert.equal(s, "7d: 0 visitors, 0 pageviews\n  publish first");
});
test("formatSearchConsole — connected numbers", () => {
  assert.equal(
    formatSearchConsole({ connected: true, site_selected: true, period: "28d", clicks: 5, impressions: 100, ctr: 0.05, position: 7.25 }),
    "28d: 5 clicks, 100 impressions, CTR 5.0%, avg position 7.3",
  );
});
test("formatTableLine / formatMessageLine / oneLine", () => {
  assert.equal(formatTableLine({ name: "t", row_count: 0, columns: [{ name: "id", type: "int", primary_key: true, nullable: false }] }), "t (~0 rows): id int pk");
  assert.equal(formatMessageLine({ created_at: "t", role: "user", content: "hi\nthere" }), "t\tuser\thi there");
  assert.equal(oneLine("x".repeat(10), 5), "xxxx…");
});
test("parseJsonArg — undefined for empty, throws a usage error naming the flag", () => {
  assert.equal(parseJsonArg("", "--where"), undefined);
  assert.deepEqual(parseJsonArg('{"a":1}', "--where"), { a: 1 });
  assert.throws(() => parseJsonArg("{a:1}", "--where"), /--where is not valid JSON/);
});
test("hintFor — actionable hints for the fixable codes", () => {
  assert.match(hintFor("INSUFFICIENT_SCOPE"), /Full preset/);
  assert.match(hintFor("DATABASE_NOT_PROVISIONED"), /add a database/);
  assert.match(hintFor("RLS_REQUIRED"), /ROW LEVEL SECURITY/);
  for (const c of ["RATE_LIMITED", "PLAN_REQUIRED", "INSUFFICIENT_CREDITS"]) assert.ok(hintFor(c), c);
  assert.match(hintFor("UNSUPPORTED_STATEMENT"), /EXPLAIN/);
  assert.equal(hintFor("SOMETHING_ELSE"), null);
});

console.log("HELP");
test("mentions every subcommand", () => {
  const text = HELP("1.2.0");
  for (const cmd of [
    "auth login", "create", "edit", "publish", "status", "list", "domains search", "domains connect", "screenshot", "mcp",
    "files ls", "files cat", "files write", "files edit", "files rm", "forms", "analytics",
    "db schema", "db rows", "db insert", "db update", "db delete", "db sql",
    "domains buy", "domains check", "task retry", "rename", "wake", "image", "search-console connect", "credits", "messages",
  ]) {
    assert.ok(text.includes(cmd), `HELP should mention "${cmd}"`);
  }
  assert.ok(text.includes("1.2.0"));
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nFORMAT TESTS OK");
