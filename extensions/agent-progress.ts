import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Only allowlisted, extension-owned values reach appendEntry. Never copy agent records,
// child events, prompts, errors, paths or tool-result details into this wire format.
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
interface Usage { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd: number }
interface Task {
  sessionId: string;
  taskId: string;
  title: string;
  startedAt: string;
  status: TaskStatus;
  usage: Usage;
  last?: string;
  progressEntries: number;
  timer?: ReturnType<typeof setTimeout>;
}
const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
const add = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const COALESCE_MS = 100;
const MAX_PROGRESS_ENTRIES = 32; // terminal settlement is always emitted, even after this limit

export function createAgentProgress(pi: ExtensionAPI) {
  let activeSession = "";
  let index = 0;
  const tasks = new Set<Task>();

  const clear = (task: Task) => {
    if (task.timer) clearTimeout(task.timer);
    task.timer = undefined;
  };
  const publish = (task: Task, ctx: ExtensionContext) => {
    clear(task);
    if (ctx.mode !== "rpc" || activeSession !== task.sessionId || ctx.sessionManager.getSessionId() !== task.sessionId) return;
    const { usage } = task;
    const data = {
      version: 1 as const, sessionId: task.sessionId, taskId: task.taskId,
      kind: "spawned_agent" as const, status: task.status, title: task.title,
      startedAt: task.startedAt, updatedAt: new Date().toISOString(),
      ...(["completed", "failed", "cancelled", "interrupted"].includes(task.status) ? { endedAt: new Date().toISOString() } : {}),
      usage: { ...usage },
    };
    // updatedAt isn't a reason to append another otherwise identical snapshot.
    const signature = JSON.stringify({ status: data.status, usage: data.usage });
    if (signature !== task.last) {
      pi.appendEntry("piano-task-progress", data);
      task.last = signature;
      if (task.status === "running" && usage.totalTokens > 0) task.progressEntries++;
    }
  };
  const queue = (task: Task, ctx: ExtensionContext) => {
    if (task.timer || task.progressEntries >= MAX_PROGRESS_ENTRIES || task.sessionId !== activeSession || ctx.mode !== "rpc") return;
    task.timer = setTimeout(() => publish(task, ctx), COALESCE_MS);
    task.timer.unref?.();
  };

  return {
    sessionStart(ctx: ExtensionContext) {
      for (const task of tasks) clear(task);
      // The old session is not writable after a switch. In-flight work retains its
      // pinned owner, so no late callback can be misattributed to the new session.
      tasks.clear();
      activeSession = ctx.sessionManager.getSessionId();
      index = 0;
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== "piano-task-progress") continue;
        const data = entry.data as { sessionId?: string; title?: string } | undefined;
        if (data?.sessionId !== activeSession) continue;
        const match = /^Agent #(\d+)$/.exec(data.title ?? "");
        if (match && Number.isSafeInteger(Number(match[1]))) index = Math.max(index, Number(match[1]));
      }
    },
    begin(ctx: ExtensionContext, status: "pending" | "running" = "running") {
      if (ctx.mode !== "rpc" || ctx.sessionManager.getSessionId() !== activeSession) return undefined;
      const task: Task = {
        sessionId: activeSession, taskId: randomUUID(), title: `Agent #${++index}`,
        startedAt: new Date().toISOString(), status, progressEntries: 0,
        usage: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
      tasks.add(task);
      publish(task, ctx);
      return task;
    },
    running(task: Task | undefined, ctx: ExtensionContext) {
      if (!task || !tasks.has(task)) return;
      task.status = "running";
      publish(task, ctx);
    },
    usage(task: Task | undefined, ctx: ExtensionContext, raw: unknown) {
      if (!task || !tasks.has(task) || !raw || typeof raw !== "object") return;
      const u = raw as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; totalTokens?: unknown; cost?: { total?: unknown } };
      const input = finite(u.input), output = finite(u.output), cached = finite(u.cacheRead);
      task.usage.inputTokens = add(task.usage.inputTokens, add(input, finite(u.cacheWrite)));
      task.usage.cachedInputTokens = add(task.usage.cachedInputTokens, cached);
      task.usage.outputTokens = add(task.usage.outputTokens, output);
      task.usage.totalTokens = add(task.usage.totalTokens,
        typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) && u.totalTokens >= 0
          ? finite(u.totalTokens) : add(add(input, output), add(cached, finite(u.cacheWrite))));
      task.usage.costUsd = add(task.usage.costUsd, finite(u.cost?.total));
      queue(task, ctx); // finalized assistant messages only, never token deltas
    },
    finish(task: Task | undefined, ctx: ExtensionContext, status: "completed" | "failed" | "cancelled" | "interrupted") {
      if (!task || !tasks.has(task)) return;
      task.status = status;
      publish(task, ctx);
      tasks.delete(task);
    },
    shutdown(ctx: ExtensionContext) {
      for (const task of tasks) {
        clear(task);
        task.status = "interrupted";
        publish(task, ctx);
      }
      tasks.clear();
      activeSession = "";
    },
  };
}
export type AgentProgress = ReturnType<typeof createAgentProgress>;
export type ProgressTask = NonNullable<ReturnType<AgentProgress["begin"]>>;
