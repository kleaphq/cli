// Smoke test: boot the stdio server and assert the expected tools register.
// Run: node test/smoke.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED = [
  "create_app", "modify_app", "check_task", "retry_task", "publish_app", "get_publish_status",
  "list_apps", "get_app", "find_app", "rename_app", "get_screenshot", "wake_app", "generate_image",
  "list_app_files", "read_files", "write_files", "edit_files", "delete_files",
  "get_form_submissions", "get_analytics", "get_search_console", "connect_search_console", "get_credits",
  "search_domains", "check_domain", "connect_domain", "buy_domain",
  "get_database_schema", "query_database_rows", "insert_database_rows", "update_database_rows",
  "delete_database_rows", "run_database_sql",
];

const child = spawn("node", ["kleap-mcp-server.mjs"], {
  cwd: root,
  env: { ...process.env, KLEAP_API_KEY: "kleap_live_sk_ci_smoke" },
});

let err = "";
child.stderr.on("data", (d) => {
  err += d.toString();
});

setTimeout(() => {
  child.kill();
  const missing = EXPECTED.filter((t) => !err.includes(t));
  if (!err.includes("ready (stdio)") || missing.length > 0) {
    console.error("SMOKE FAIL");
    console.error("  missing tools:", missing);
    console.error("  stderr:", err.slice(0, 400));
    process.exit(1);
  }
  console.log(`SMOKE OK — server booted, all ${EXPECTED.length} tools present.`);
  process.exit(0);
}, 2500);
