import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// This shared accounting module also lives in the auto-discovered extensions directory.
// Export a harmless factory so Pi can load it while the UI consumes its helpers.
export default function usageExtension(_pi: ExtensionAPI): void {}

export interface Totals { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export const emptyTotals = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
export function addUsage(t: Totals, u: any): void {
  if (!u) return;
  t.input += u.input ?? 0;
  t.output += u.output ?? 0;
  t.cacheRead += u.cacheRead ?? 0;
  t.cacheWrite += u.cacheWrite ?? 0;
  t.cost += u.cost?.total ?? 0;
}
function merge(t: Totals, other: Totals): void {
  t.input += other.input;
  t.output += other.output;
  t.cacheRead += other.cacheRead;
  t.cacheWrite += other.cacheWrite;
  t.cost += other.cost;
}

export function entryUsage(e: any): any {
  if (e.type === "usage" || e.type === "compaction" || e.type === "branch_summary") return e.usage;
  if (e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult")) return e.message.usage;
  return undefined;
}

interface SessionFile { header: any; entries: any[] }
const cache = new Map<string, { mtime: number; size: number; data: SessionFile }>();
function sessionFile(file: string): SessionFile | undefined {
  try {
    const stat = fs.statSync(file);
    const cached = cache.get(file);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.data;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const entries: any[] = [];
    for (const line of lines) {
      if (!line) continue;
      try { entries.push(JSON.parse(line)); } catch { /* a concurrent writer may leave a partial last line */ }
    }
    const data = { header: entries.find((e) => e.type === "session"), entries: entries.filter((e) => e.type !== "session") };
    cache.set(file, { mtime: stat.mtimeMs, size: stat.size, data });
    return data;
  } catch { return undefined; }
}

function jsonFiles(dir: string): string[] {
  try { return fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name)); }
  catch { return []; }
}

// A fork copies its ancestor's entry IDs. Charge copied entries only once when both files are included.
function countFiles(files: string[], include: (entry: any, file: string) => boolean, parentFile?: string, parentIds?: Set<string>): Totals {
  const totals = emptyTotals();
  const seen = new Set<string>();
  const unique = [...new Set(files.map((f) => path.resolve(f)))];
  const loaded = unique.map((file) => ({ file, data: sessionFile(file) })).filter((x) => x.data?.header);
  const included = new Set(loaded.map((x) => x.file));
  const ancestorFile = (file: string, parent: unknown): string | undefined =>
    typeof parent === "string" ? path.resolve(path.dirname(file), parent) : undefined;
  // Ancestor first, to retain the original entry and ignore its copied descendants.
  const depth = (file: string, visited = new Set<string>()): number => {
    if (visited.has(file)) return 0;
    visited.add(file);
    const parent = ancestorFile(file, loaded.find((x) => x.file === file)?.data?.header?.parentSession);
    return parent && included.has(parent) ? 1 + depth(parent, visited) : 0;
  };
  loaded.sort((a, b) => depth(a.file) - depth(b.file));
  for (const { file, data } of loaded) {
    for (const entry of data!.entries) {
      if (!include(entry, file)) continue;
      const key = entry.id ? `${file}\0${entry.id}` : undefined;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      // Only collapse duplicate IDs copied from a file actually included in this subtotal.
      let ancestor = ancestorFile(file, data!.header?.parentSession);
      let copied = false;
      const visited = new Set<string>();
      while (ancestor && !visited.has(ancestor)) {
        visited.add(ancestor);
        if (entry.id && ((included.has(ancestor) && seen.has(`${ancestor}\0${entry.id}`)) ||
          (parentFile && ancestor === path.resolve(parentFile) && parentIds?.has(entry.id)))) { copied = true; break; }
        ancestor = ancestorFile(ancestor, sessionFile(ancestor)?.header?.parentSession);
      }
      if (!copied) addUsage(totals, entryUsage(entry));
    }
  }
  return totals;
}

// Index run metadata incrementally. A render never opens every run.json in a large history.
// Explicitly linked runs (and their resume ancestors) are resolved directly below.
const RUN_SCAN_BATCH = 128;
const runIndexes = new Map<string, { dir: fs.Dir | undefined; runs: Map<string, any>; mtime: number }>();
export function hasPendingRunScan(agentDir = getAgentDir()): boolean {
  return Boolean(runIndexes.get(path.join(agentDir, "ultracode", "runs"))?.dir);
}
function indexedRuns(root: string): Map<string, any> {
  let mtime: number;
  try { mtime = fs.statSync(root).mtimeMs; } catch { return new Map(); }
  let index = runIndexes.get(root);
  if (!index || index.mtime !== mtime) {
    index?.dir?.closeSync();
    index = { dir: fs.opendirSync(root), runs: new Map(), mtime };
    runIndexes.set(root, index);
  }
  for (let i = 0; i < RUN_SCAN_BATCH && index.dir; i++) {
    const entry = index.dir.readSync();
    if (!entry) { index.dir.closeSync(); index.dir = undefined; break; }
    if (!entry.isDirectory() || !/^[\w-]+$/.test(entry.name)) continue;
    try { index.runs.set(entry.name, JSON.parse(fs.readFileSync(path.join(root, entry.name, "run.json"), "utf8"))); } catch {}
  }
  return index.runs;
}

interface Range { sessionId: string; startedAt: string; endedAt?: string; toolCallId?: string }
interface AgentRecord { sessionDir?: string; accounting?: Range[] }

/** Billable entries in this session (including inactive branches) and linked child Pi session files. */
export function collectUsage(ctx: { sessionManager: { getEntries(): any[]; getSessionId(): string; getSessionFile(): string | undefined } }, agentDir = getAgentDir()) {
  const parent = emptyTotals();
  const agents = emptyTotals();
  const workflows = emptyTotals();
  const entries = ctx.sessionManager.getEntries();
  const sessionId = ctx.sessionManager.getSessionId();
  const parentFile = ctx.sessionManager.getSessionFile();
  const sessionIds = new Set([sessionId]);
  // Forked parent entries are copied; their original child charges belong to the forked history too.
  let ancestor = parentFile && sessionFile(parentFile)?.header?.parentSession;
  if (ancestor && parentFile) ancestor = path.resolve(path.dirname(parentFile), ancestor);
  const visited = new Set<string>();
  const entryIds = new Set(entries.map((e) => e.id).filter(Boolean));
  while (ancestor && !visited.has(ancestor)) {
    visited.add(ancestor);
    const original = sessionFile(ancestor);
    // /new can also point at a previous session without copying its history.
    if (!original?.entries.some((e) => entryIds.has(e.id))) break;
    if (original.header?.id) sessionIds.add(original.header.id);
    const previous = original.header?.parentSession;
    ancestor = typeof previous === "string" ? path.resolve(path.dirname(ancestor), previous) : undefined;
  }
  const names = new Set<string>();
  const runIds = new Set<string>();
  const representedAgents = new Set<string>();
  const meteredAgentCalls = new Set<string>();
  const representedRuns = new Set<string>();
  for (const e of entries) {
    addUsage(parent, entryUsage(e));
    if (e.type !== "message") continue;
    const m = e.message;
    if (m?.role === "assistant") {
      for (const part of m.content ?? []) {
        if (part.type !== "toolCall") continue;
        if (["spawn_agent", "send_message", "followup_task"].includes(part.name)) {
          const name = part.arguments?.name ?? part.arguments?.agent;
          if (typeof name === "string" && /^[\w-]{1,32}$/.test(name)) names.add(name);
        }
      }
    } else if (m?.role === "toolResult") {
      const details = m.details;
      if (typeof details?.runId === "string") runIds.add(details.runId);
      if (m.usage) {
        if (m.toolName === "workflow" && typeof details?.runId === "string") representedRuns.add(details.runId);
        if (["spawn_agent", "send_message", "followup_task"].includes(m.toolName)) {
          if (typeof details?.name === "string") representedAgents.add(details.name);
          if (typeof m.toolCallId === "string") meteredAgentCalls.add(m.toolCallId);
        }
      }
    }
  }

  let registry: { agents?: Record<string, AgentRecord> } = {};
  try { registry = JSON.parse(fs.readFileSync(path.join(agentDir, "pi-extended-agents.json"), "utf8")); } catch {}
  for (const name of names) {
    const record = registry.agents?.[name];
    const dir = path.join(agentDir, "pi-extended-agent-sessions", name);
    const ranges = record?.accounting?.filter((r) => sessionIds.has(r.sessionId) &&
      (r.toolCallId ? !meteredAgentCalls.has(r.toolCallId) : !representedAgents.has(name))) ?? [];
    // Legacy entries outside a session-owned accounting window have unknown ownership.
    const result = countFiles(jsonFiles(dir), (e) => {
      const time = Date.parse(e.timestamp);
      return Number.isFinite(time) && ranges.some((r) => time >= Date.parse(r.startedAt) &&
        (!r.endedAt || time <= Date.parse(r.endedAt)));
    }, parentFile, entryIds);
    merge(agents, result);
  }

  const runsRoot = path.join(agentDir, "ultracode", "runs");
  const runs = new Map(indexedRuns(runsRoot));
  const resolveRun = (id: string): any => {
    if (!/^[\w-]+$/.test(id)) return undefined;
    if (runs.has(id)) return runs.get(id);
    try {
      const run = JSON.parse(fs.readFileSync(path.join(runsRoot, id, "run.json"), "utf8"));
      runs.set(id, run);
      return run;
    } catch { return undefined; }
  };
  // Follow sources even when owned by another session or not yet reached by the index.
  const sourceRuns = new Set<string>();
  for (const id of runIds) {
    const visitedSources = new Set<string>();
    let source = resolveRun(id)?.resumedFrom;
    while (typeof source === "string" && !visitedSources.has(source)) {
      visitedSources.add(source);
      const run = resolveRun(source);
      if (!run) break;
      sourceRuns.add(source);
      source = run.resumedFrom;
    }
  }
  // A metered resumed workflow reports cumulative usage of its source run(s).
  // Suppress those source sessions too, even if their own tool result had no usage.
  for (const id of [...representedRuns]) {
    const visitedSources = new Set<string>();
    let source = resolveRun(id)?.resumedFrom;
    while (typeof source === "string" && !visitedSources.has(source)) {
      visitedSources.add(source);
      const run = resolveRun(source);
      if (!run) break;
      representedRuns.add(source);
      source = run.resumedFrom;
    }
  }
  const files: string[] = [];
  for (const [id, run] of runs) {
    if (representedRuns.has(id) || !(sessionIds.has(run.sessionId) || runIds.has(id) || sourceRuns.has(id))) continue;
    const root = path.join(runsRoot, id);
    let children: string[] = [];
    try { children = fs.readdirSync(path.join(root, "agents")); } catch {}
    for (const child of children) {
      if (!/^\d+$/.test(child)) continue;
      files.push(...jsonFiles(path.join(root, "agents", child)));
    }
  }
  const workflowTotal = countFiles(files, () => true, parentFile, entryIds);
  merge(workflows, workflowTotal);
  const total = emptyTotals();
  for (const t of [parent, agents, workflows]) merge(total, t);
  return { parent, agents, workflows, total };
}
