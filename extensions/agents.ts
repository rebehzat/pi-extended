import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expandHome, nowIso, readJson, serializeError, tmpDirFor, truncate, writeJsonAtomic } from "./lib.ts";

type AgentStatus = "running" | "idle" | "error";

interface AgentRecord {
  name: string;
  sessionDir: string;
  model?: string;
  tools?: string[];
  thinking?: string;
  cwd: string;
  createdAt: string;
  lastActivity?: string;
  lastOutput?: string;
  lastExitCode?: number | null;
  status: AgentStatus;
  queue: string[];
  turnCount: number;
  usage: { turns: number; input: number; output: number; cost: number };
}

interface AgentState {
  agents: Record<string, AgentRecord>;
}

interface RunningTurn {
  proc: ChildProcess;
  record: AgentRecord;
}

type UpdateFn = (partial: AgentToolResult<unknown>) => void;

const MAX_WAIT_MS = 60 * 60 * 1000;
const OUTPUT_CAP = 24 * 1024;

let running = new Map<string, RunningTurn>();

function stateFile(): string {
  return path.join(getAgentDir(), "pi-extended-agents.json");
}

function sessionsRoot(): string {
  return path.join(getAgentDir(), "pi-extended-agent-sessions");
}

function loadState(): AgentState {
  const state = readJson<AgentState>(stateFile(), { agents: {} });
  for (const rec of Object.values(state.agents)) {
    if (rec.status === "running" && !running.has(rec.name)) {
      rec.status = "error";
      rec.lastOutput = rec.lastOutput ?? "(pi restarted while agent was running; turn lost)";
    }
  }
  return state;
}

async function saveState(state: AgentState): Promise<void> {
  await writeJsonAtomic(stateFile(), state);
}

async function persist(record: AgentRecord): Promise<void> {
  const state = loadState();
  state.agents[record.name] = record;
  await saveState(state);
}

function validName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,32}$/.test(name);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

interface TurnResult {
  output: string;
  exitCode: number;
  stderr: string;
  usage: { turns: number; input: number; output: number; cost: number };
  stopReason?: string;
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

async function runTurn(
  record: AgentRecord,
  prompt: string,
  isContinue: boolean,
  signal?: AbortSignal,
  onUpdate?: UpdateFn,
): Promise<TurnResult> {
  const args: string[] = ["--mode", "json", "-p", "--session-dir", record.sessionDir];
  if (isContinue) args.push("--continue");
  if (record.model) args.push("--model", record.model);
  if (record.tools && record.tools.length > 0) args.push("--tools", record.tools.join(","));
  if (record.thinking) args.push("--thinking", record.thinking);

  let preambleDir: string | null = null;
  try {
    preambleDir = await tmpDirFor("pi-agent-preamble-");
    const preambleFile = path.join(preambleDir, "preamble.md");
    const preamble = [
      `You are the subagent "${record.name}" spawned by a coordinating pi agent.`,
      "Work autonomously on the task you are given. Do not ask the coordinator questions; make reasonable assumptions and proceed.",
      "Your final text output is returned verbatim to the coordinator, so make it a complete, self-contained report.",
    ].join(" ");
    await fs.promises.writeFile(preambleFile, preamble, "utf8");
    args.push("--append-system-prompt", preambleFile);
  } catch {
    preambleDir = null;
  }

  args.push(prompt);

  const result: TurnResult = {
    output: "",
    exitCode: 1,
    stderr: "",
    usage: { turns: 0, input: 0, output: 0, cost: 0 },
  };
  const messages: Message[] = [];

  try {
    result.exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: record.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      running.set(record.name, { proc, record });
      record.status = "running";

      let buffer = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          messages.push(msg);
          if (msg.role === "assistant") {
            result.usage.turns++;
            const usage = (msg as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage;
            if (usage) {
              result.usage.input += usage.input ?? 0;
              result.usage.output += usage.output ?? 0;
              result.usage.cost += usage.cost?.total ?? 0;
            }
            const stop = (msg as { stopReason?: string }).stopReason;
            if (stop) result.stopReason = stop;
            if (onUpdate) {
              onUpdate({
                content: [{ type: "text", text: truncate(getFinalOutput(messages) || "(running...)", 2000) }],
                details: { agent: record.name },
              });
            }
          }
        }
      };

      proc.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr?.on("data", (data: Buffer) => {
        result.stderr += data.toString();
        if (result.stderr.length > 64 * 1024) result.stderr = result.stderr.slice(-64 * 1024);
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        running.delete(record.name);
        resolve(code ?? 0);
      });
      proc.on("error", () => {
        running.delete(record.name);
        result.stderr += `\n[failed to spawn pi: invocation was ${invocation.command} ${invocation.args.join(" ")}]`;
        resolve(1);
      });

      if (signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (proc.exitCode === null) proc.kill("SIGKILL");
          }, 5000).unref();
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.output = getFinalOutput(messages) || (result.stderr ? truncate(result.stderr, 2000) : "(no output)");
    return result;
  } finally {
    if (preambleDir) {
      try {
        await fs.promises.rm(preambleDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function isTurnOk(turn: TurnResult): boolean {
  return turn.exitCode === 0 && turn.stopReason !== "error" && turn.stopReason !== "aborted";
}

function formatRecord(rec: AgentRecord): string {
  const live = running.has(rec.name) || rec.status === "running";
  const status = live ? "running" : rec.status;
  const queued = rec.queue.length > 0 ? `, ${rec.queue.length} queued` : "";
  const usage = `turns:${rec.usage.turns} in:${Math.round(rec.usage.input / 1000)}k out:${Math.round(rec.usage.output / 1000)}k cost:$${rec.usage.cost.toFixed(4)}`;
  return [
    `${rec.name} [${status}${queued}] model=${rec.model ?? "inherit"} cwd=${rec.cwd}`,
    `  turns: ${rec.turnCount} | ${usage} | last activity: ${rec.lastActivity ?? rec.createdAt}`,
    `  last output: ${truncate(rec.lastOutput ?? "(none)", 300).replace(/\n/g, " ")}`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  const applyTurnResult = (record: AgentRecord, turn: TurnResult): void => {
    record.lastOutput = turn.output;
    record.lastExitCode = turn.exitCode;
    record.lastActivity = nowIso();
    record.usage.turns += turn.usage.turns;
    record.usage.input += turn.usage.input;
    record.usage.output += turn.usage.output;
    record.usage.cost += turn.usage.cost;
    record.status = isTurnOk(turn) ? "idle" : "error";
  };

  const kickQueue = async (record: AgentRecord, signal?: AbortSignal): Promise<void> => {
    while (record.queue.length > 0 && !running.has(record.name)) {
      const next = record.queue.shift()!;
      record.turnCount++;
      const turn = await runTurn(record, next, true, signal);
      applyTurnResult(record, turn);
    }
    await persist(record);
  };

  const startAgent = async (
    record: AgentRecord,
    prompt: string,
    signal?: AbortSignal,
    onUpdate?: UpdateFn,
  ): Promise<void> => {
    record.turnCount = 1;
    const turn = await runTurn(record, prompt, false, signal, onUpdate);
    applyTurnResult(record, turn);
    await kickQueue(record, signal);
  };

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Spawn a named subagent: a separate headless pi process with its own session, model, and tools, running the given task in the background. " +
      "Returns immediately; collect results with wait_agent or list_agents. The agent's session is kept, so send_message/followup_task can continue the conversation later. " +
      "Re-spawning an existing idle agent continues its session with the new task.",
    promptSnippet: "Spawn a named background subagent (separate pi process + session) to run a task",
    promptGuidelines: [
      "Use spawn_agent to delegate self-contained subtasks (research, long refactors, parallel work); pass a complete task description since the subagent cannot see this conversation.",
      "After spawning, use wait_agent to collect output, send_message to nudge a running agent, and followup_task to queue follow-up work.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Short unique agent name (letters, digits, -, _)" }),
      task: Type.String({ description: "Complete, self-contained task for the agent" }),
      model: Type.Optional(Type.String({ description: 'Model override, e.g. "anthropic/claude-sonnet-4-5" (default: inherit)' })),
      tools: Type.Optional(Type.Array(Type.String(), { description: 'Restrict built-in tools, e.g. ["read","bash"] (default: all)' })),
      thinking: Type.Optional(Type.String({ description: "Thinking level override: off|minimal|low|medium|high" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the agent (default: current dir)" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const name = params.name.trim();
      if (!validName(name)) {
        throw new Error("Invalid agent name: use 1-32 chars of letters, digits, '-', '_'.");
      }
      const state = loadState();
      const existing = state.agents[name];
      if (existing && (running.has(name) || existing.status === "running")) {
        throw new Error(`Agent "${name}" is already running. Use send_message or wait_agent.`);
      }

      const cwd = expandHome(params.cwd ?? ctx.cwd);
      const sessionDir = path.join(sessionsRoot(), name);
      await fs.promises.mkdir(sessionDir, { recursive: true });

      const record: AgentRecord = existing ?? {
        name,
        sessionDir,
        model: params.model,
        tools: params.tools,
        thinking: params.thinking,
        cwd,
        createdAt: nowIso(),
        status: "running",
        queue: [],
        turnCount: 0,
        usage: { turns: 0, input: 0, output: 0, cost: 0 },
      };
      record.sessionDir = sessionDir;
      record.cwd = cwd;
      if (params.model) record.model = params.model;
      if (params.tools) record.tools = params.tools;
      if (params.thinking) record.thinking = params.thinking;
      record.status = "running";
      record.queue = [];

      state.agents[name] = record;
      await saveState(state);

      void startAgent(record, params.task, signal, onUpdate).catch((err) => {
        record.status = "error";
        record.lastOutput = serializeError(err);
        record.lastActivity = nowIso();
        void persist(record);
      });

      return {
        content: [
          {
            type: "text",
            text: `Spawned agent "${name}" (task running in background, session dir: ${sessionDir}).\nCollect with wait_agent(agent="${name}") or list_agents(); message it with send_message; queue follow-ups with followup_task.`,
          },
        ],
        details: { name, status: "running", sessionDir },
      };
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description:
      "Send a message to a named subagent. If it is mid-task the message is queued and delivered right after the current task finishes; if idle, a new turn starts immediately (resuming its session) and the agent's reply is returned.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name" }),
      message: Type.String({ description: "Message/instruction for the agent" }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx): Promise<AgentToolResult<unknown>> {
      const state = loadState();
      const record = state.agents[params.agent];
      if (!record) {
        const available = Object.keys(state.agents).join(", ") || "none";
        throw new Error(`Unknown agent "${params.agent}". Known: ${available}.`);
      }
      if (running.has(record.name) || record.status === "running") {
        record.queue.push(params.message);
        await persist(record);
        return {
          content: [
            {
              type: "text",
              text: `Agent "${record.name}" is busy; message queued (position ${record.queue.length}). It will be delivered when the current task completes.`,
            },
          ],
          details: { name: record.name, queued: true },
        };
      }
      record.turnCount++;
      const turn = await runTurn(record, params.message, true, signal, onUpdate);
      applyTurnResult(record, turn);
      void kickQueue(record, signal).catch(() => {});
      await persist(record);
      return {
        content: [{ type: "text", text: `Agent "${record.name}" turn complete:\n\n${truncate(turn.output, OUTPUT_CAP)}` }],
        details: { name: record.name, status: record.status },
      };
    },
  });

  pi.registerTool({
    name: "followup_task",
    label: "Followup Task",
    description:
      "Queue a follow-up task for a subagent without blocking. The task runs after the agent finishes its current work (or immediately if idle). Check progress later with wait_agent/list_agents.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name" }),
      task: Type.String({ description: "Follow-up task" }),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const state = loadState();
      const record = state.agents[params.agent];
      if (!record) {
        const available = Object.keys(state.agents).join(", ") || "none";
        throw new Error(`Unknown agent "${params.agent}". Known: ${available}.`);
      }
      record.queue.push(params.task);
      await persist(record);
      if (!running.has(record.name) && record.status !== "running") {
        void kickQueue(record).catch(() => {});
        return {
          content: [
            { type: "text", text: `Agent "${record.name}" was idle; follow-up task started now. Check with wait_agent(agent="${record.name}").` },
          ],
          details: { name: record.name, queued: false },
        };
      }
      return {
        content: [
          { type: "text", text: `Follow-up queued for "${record.name}" (position ${record.queue.length}). It runs after current work completes.` },
        ],
        details: { name: record.name, queued: true },
      };
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "List known subagents with status, queued work, usage, and last output preview.",
    parameters: Type.Object({}),

    async execute(): Promise<AgentToolResult<unknown>> {
      const state = loadState();
      const agents = Object.values(state.agents);
      if (agents.length === 0) {
        return { content: [{ type: "text", text: "No agents yet. Spawn one with spawn_agent." }], details: { agents: [] } };
      }
      return {
        content: [{ type: "text", text: agents.map(formatRecord).join("\n\n") }],
        details: { agents: agents.map((r) => ({ name: r.name, status: r.status, queued: r.queue.length })) },
      };
    },
  });

  pi.registerTool({
    name: "wait_agent",
    label: "Wait Agent",
    description:
      'Block until a subagent finishes (agent name, or "all"), up to timeout_s. Returns the final output of the waited agents; if the timeout hits, returns current status instead.',
    parameters: Type.Object({
      agent: Type.String({ description: 'Agent name or "all"' }),
      timeout_s: Type.Optional(Type.Number({ description: "Max seconds to wait (default 300, max 3600)", default: 300 })),
    }),

    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const state = loadState();
      const names = params.agent === "all" ? Object.keys(state.agents) : [params.agent];
      if (names.length === 0 || (params.agent !== "all" && !state.agents[params.agent])) {
        throw new Error(`Unknown agent "${params.agent}". Use list_agents.`);
      }
      const timeoutMs = Math.min(Math.max(1, (params.timeout_s ?? 300) * 1000), MAX_WAIT_MS);
      const deadline = Date.now() + timeoutMs;

      const stillRunning = () => names.filter((n) => running.has(n) || state.agents[n]?.status === "running");

      let pending = stillRunning();
      while (pending.length > 0 && Date.now() < deadline && !signal?.aborted) {
        await new Promise((r) => setTimeout(r, 400));
        pending = stillRunning();
      }

      const fresh = loadState();
      const parts = names.map((n) => {
        const rec = fresh.agents[n];
        if (!rec) return `${n}: unknown`;
        const isRunning = running.has(n) || rec.status === "running";
        if (isRunning) {
          return `${n}: still running (waited ${Math.round(timeoutMs / 1000)}s). Queue: ${rec.queue.length}. Partial output: ${truncate(rec.lastOutput ?? "(none yet)", 1000)}`;
        }
        return `${n} [${rec.status}] (exit ${rec.lastExitCode ?? "?"}):\n${truncate(rec.lastOutput ?? "(no output)", OUTPUT_CAP)}`;
      });
      return {
        content: [{ type: "text", text: parts.join("\n\n---\n\n") }],
        details: { waited: names, timed_out: pending.length > 0 },
      };
    },
  });

  pi.registerTool({
    name: "kill_agent",
    label: "Kill Agent",
    description:
      "Terminate a running subagent process. Its session is kept: spawn_agent with the same name or send_message continues it.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name" }),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const state = loadState();
      const record = state.agents[params.agent];
      if (!record) throw new Error(`Unknown agent "${params.agent}".`);
      const turn = running.get(record.name);
      if (!turn) {
        return {
          content: [{ type: "text", text: `Agent "${record.name}" is not running (status: ${record.status}).` }],
          details: { name: record.name, killed: false },
        };
      }
      turn.proc.kill("SIGTERM");
      setTimeout(() => {
        if (turn.proc.exitCode === null) turn.proc.kill("SIGKILL");
      }, 3000).unref();
      record.status = "idle";
      await persist(record);
      return {
        content: [{ type: "text", text: `Termination signal sent to "${record.name}".` }],
        details: { name: record.name, killed: true },
      };
    },
  });

  pi.registerCommand("agents", {
    description: "Show spawned subagents",
    handler: async (_args, ctx) => {
      const state = loadState();
      const agents = Object.values(state.agents);
      ctx.ui.notify(agents.length === 0 ? "No agents yet." : agents.map(formatRecord).join("\n\n"), "info");
    },
  });

  pi.on("session_shutdown", async () => {
    for (const [, turn] of running) {
      try {
        turn.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    running = new Map();
  });
}
