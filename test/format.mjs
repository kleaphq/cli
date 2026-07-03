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

console.log("HELP");
test("mentions every subcommand", () => {
  const text = HELP("1.2.0");
  for (const cmd of ["auth login", "create", "edit", "publish", "status", "list", "domains search", "domains connect", "screenshot", "mcp"]) {
    assert.ok(text.includes(cmd), `HELP should mention "${cmd}"`);
  }
  assert.ok(text.includes("1.2.0"));
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nFORMAT TESTS OK");
