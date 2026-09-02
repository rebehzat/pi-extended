import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const load = createJiti(import.meta.url, { interopDefault: true });

const registered = { tools: [], commands: [], events: [] };
const mockPi = {
  registerTool: (def) => registered.tools.push(def),
  registerCommand: (name) => registered.commands.push(name),
  on: (event) => registered.events.push(event),
  sendMessage: () => {},
  sendUserMessage: () => {},
  appendEntry: () => {},
  registerEntryRenderer: () => {},
  registerMessageRenderer: () => {},
  registerShortcut: () => {},
  registerFlag: () => {},
  exec: async () => ({ stdout: "", code: 0 }),
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piext-smoke-"));
const mockCtx = { cwd: tmp, ui: { setWidget: () => {}, notify: () => {} }, model: undefined, thinkingLevel: undefined };
const noop = () => {};
const abort = undefined;

async function call(tool, params) {
  return tool.execute("call-1", params, abort, noop, mockCtx);
}

const files = ["web-search.ts", "web-run.ts", "terminals.ts", "view-image.ts", "goals.ts", "agents.ts", "lib.ts"];
for (const f of files) {
  const mod = load(`./extensions/${f}`);
  if (f === "lib.ts") continue;
  if (typeof mod.default !== "function") throw new Error(`${f}: missing default export`);
  mod.default(mockPi);
}

console.log(`loaded OK: ${registered.tools.length} tools [${registered.tools.map((t) => t.name).join(", ")}]`);
console.log(`commands: [${registered.commands.join(", ")}] events: [${registered.events.join(", ")}]`);

const byName = Object.fromEntries(registered.tools.map((t) => [t.name, t]));
const expect = ["search", "web_run", "spawn_terminal", "write_stdin", "read_terminal", "list_terminals", "kill_terminal", "view_image", "goal_create", "goal_update", "goal_finish", "goal_list", "spawn_agent", "send_message", "followup_task", "list_agents", "wait_agent", "kill_agent"];
for (const name of expect) {
  if (!byName[name]) throw new Error(`missing tool: ${name}`);
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${extra ? ` :: ${extra}` : ""}`);
  if (!cond) failures++;
};

// terminals: spawn cat, write stdin, read, kill
const spawn = await call(byName.spawn_terminal, { command: "cat", label: "cat-test" });
const tid = spawn.details.terminal_id;
const w = await call(byName.write_stdin, { terminal_id: tid, input: "hello-pi-extended", settle_ms: 400 });
check("write_stdin roundtrip", w.content[0].text.includes("hello-pi-extended"));
await call(byName.kill_terminal, { terminal_id: tid });

// read_terminal offset continuity
const t2 = await call(byName.spawn_terminal, { command: "echo one; sleep 0.2; echo two", label: "seq" });
const tid2 = t2.details.terminal_id;
await new Promise((r) => setTimeout(r, 700));
const r1 = await call(byName.read_terminal, { terminal_id: tid2 });
check("read_terminal full", r1.content[0].text.includes("one") && r1.content[0].text.includes("two"));

// goals: create/update/finish/list
const g = await call(byName.goal_create, { title: "Ship pi-extended", description: "all tools working", priority: "high" });
const gid = g.details.goal.id;
check("goal_create", g.content[0].text.includes("Ship pi-extended"));
await call(byName.goal_update, { id: gid, note: "typecheck green" });
await call(byName.goal_create, { title: "Sub: write README", parent_id: gid });
const fin = await call(byName.goal_finish, { id: gid, summary: "done" });
check("goal_finish cascades", fin.content[0].text.includes("Also closed child goals"));
const list = await call(byName.goal_list, { status: "all" });
check("goal_list", list.content[0].text.includes("Ship pi-extended"));
check("goals session-scoped (no file written)", !fs.existsSync(path.join(tmp, ".pi", "goals.json")));

// view_image: 1x1 png
const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pngPath = path.join(tmp, "px.png");
fs.writeFileSync(pngPath, Buffer.from(pngB64, "base64"));
const v = await call(byName.view_image, { path: pngPath });
check("view_image local", v.content[0].type === "image" && v.content[0].mimeType === "image/png");
try {
  await call(byName.view_image, { path: path.join(tmp, "nope.png") });
  check("view_image missing file throws", false);
} catch {
  check("view_image missing file throws", true);
}

// web_run time (offline-safe)
const time = await call(byName.web_run, { action: "time", timezone: ["UTC", "America/New_York"] });
check("web_run time", time.content[0].text.includes("UTC") && time.content[0].text.includes("America/New_York"));

// web_run finance (network)
try {
  const fin2 = await call(byName.web_run, { action: "finance", symbols: "AAPL" });
  check("web_run finance", fin2.content[0].text.includes("AAPL"), fin2.content[0].text.split("\n")[1]?.slice(0, 90));
} catch (e) {
  check("web_run finance", false, String(e).slice(0, 100));
}

// search (network)
try {
  const s = await call(byName.search, { query: "pi coding agent earendil-works", max_results: 3 });
  check("search duckduckgo/tavily", /results for/.test(s.content[0].text), s.content[0].text.split("\n")[0]);
} catch (e) {
  check("search duckduckgo/tavily", false, String(e).slice(0, 100));
}

// web_run open (network)
try {
  const o = await call(byName.web_run, { action: "open", url: "https://example.com" });
  check("web_run open", o.content[0].text.includes("Page #") && o.content[0].text.includes("example.com"));
} catch (e) {
  check("web_run open", false, String(e).slice(0, 100));
}

// agents: list_agents offline-safe
const la = await call(byName.list_agents, {});
check("list_agents", la.content[0].text.length > 0);

// agents: spawn a real subagent (uses local `pi` if available; expect graceful failure otherwise)
try {
  const sa = await call(byName.spawn_agent, { name: "smoke-1", task: "Say exactly: SMOKE_OK" });
  check("spawn_agent returns", sa.content[0].text.includes("smoke-1"));
  const wa = await call(byName.wait_agent, { agent: "smoke-1", timeout_s: 60 });
  check("wait_agent", wa.content[0].text.includes("smoke-1"));
  console.log("  subagent output preview:", wa.content[0].text.split("\n").slice(0, 2).join(" | ").slice(0, 160));
} catch (e) {
  check("spawn_agent/wait_agent", false, String(e).slice(0, 120));
}

console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
