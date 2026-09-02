import { spawn, type ChildProcess } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expandHome, truncate } from "./lib.ts";

const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_OUTPUT_RETURN = 64 * 1024;

interface Terminal {
  id: number;
  label: string;
  command: string;
  cwd: string;
  proc: ChildProcess;
  buffer: string;
  dropped: number;
  cursor: number;
  createdAt: number;
  killed: boolean;
}

let terminals = new Map<number, Terminal>();
let nextId = 1;

function terminalOutput(term: Terminal, fromOffset: number): { text: string; nextOffset: number } {
  const start = Math.max(0, fromOffset - term.dropped);
  return { text: term.buffer.slice(start), nextOffset: term.dropped + term.buffer.length };
}

function appendOutput(term: Terminal, chunk: string): void {
  term.buffer += chunk;
  if (term.buffer.length > MAX_BUFFER_BYTES) {
    const drop = term.buffer.length - MAX_BUFFER_BYTES;
    term.buffer = term.buffer.slice(drop);
    term.dropped += drop;
    if (term.cursor < term.dropped) term.cursor = term.dropped;
  }
}

function statusLine(term: Terminal): string {
  const state =
    term.proc.exitCode !== null && term.proc.exitCode !== undefined
      ? `exited(${term.proc.exitCode})`
      : term.proc.signalCode
        ? `killed(${term.proc.signalCode})`
        : "running";
  const bytes = term.dropped + term.buffer.length;
  return `#${term.id} [${state}] "${term.label}" cmd: ${truncate(term.command, 80)} | ${bytes} bytes | cwd: ${term.cwd}`;
}

function killTerminal(term: Terminal): void {
  if (term.proc.exitCode !== null) return;
  term.killed = true;
  term.proc.kill("SIGTERM");
  setTimeout(() => {
    if (term.proc.exitCode === null) term.proc.kill("SIGKILL");
  }, 2000).unref();
}

function readResult(
  term: Terminal,
  fromOffset: number,
): { text: string; nextOffset: number; running: boolean; exitCode?: number | null } {
  const { text, nextOffset } = terminalOutput(term, fromOffset);
  term.cursor = nextOffset;
  return {
    text: truncate(text, MAX_OUTPUT_RETURN),
    nextOffset,
    running: term.proc.exitCode === null && !term.proc.signalCode,
    exitCode: term.proc.exitCode,
  };
}

function getTerminal(params: { terminal_id: number }): Terminal {
  const term = terminals.get(params.terminal_id);
  if (!term) throw new Error(`Unknown terminal_id ${params.terminal_id}. Use list_terminals.`);
  return term;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "spawn_terminal",
    label: "Spawn Terminal",
    description:
      "Start a command in a persistent background terminal (its own bash process with stdin/stdout pipes) and return a terminal id " +
      "immediately without waiting for the command to finish. Use read_terminal to poll output, write_stdin to send input " +
      "(REPLs, debuggers, servers, long builds), kill_terminal to stop it. Terminals are children of this pi process and are " +
      "terminated when the session shuts down.",
    promptSnippet: "Start a long-running background command and interact with it via write_stdin",
    promptGuidelines: [
      "Use spawn_terminal for servers, watchers, REPLs, or long jobs instead of blocking bash; interact with write_stdin and poll with read_terminal.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Command line to run (executed via bash -lc)" }),
      label: Type.Optional(Type.String({ description: "Short human label for this terminal" })),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: current dir)" })),
      initial_stdin: Type.Optional(Type.String({ description: "Optional text written to stdin right after spawn" })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const cwd = expandHome(params.cwd ?? process.cwd());
      const proc = spawn("/bin/bash", ["-lc", params.command], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
      });

      const term: Terminal = {
        id: nextId++,
        label: params.label ?? params.command.slice(0, 40),
        command: params.command,
        cwd,
        proc,
        buffer: "",
        dropped: 0,
        cursor: 0,
        createdAt: Date.now(),
        killed: false,
      };
      terminals.set(term.id, term);

      proc.stdout?.on("data", (d: Buffer) => appendOutput(term, d.toString("utf8")));
      proc.stderr?.on("data", (d: Buffer) => appendOutput(term, d.toString("utf8")));
      proc.on("error", (err) => appendOutput(term, `\n[spawn error] ${err.message}\n`));
      proc.on("close", (code, signal) => {
        if (signal && code === null) appendOutput(term, `\n[terminated by ${signal}]\n`);
        else if (code !== null && code !== 0) appendOutput(term, `\n[exit code ${code}]\n`);
        appendOutput(term, `\n[terminal closed]\n`);
      });

      if (params.initial_stdin) {
        proc.stdin?.write(params.initial_stdin.endsWith("\n") ? params.initial_stdin : `${params.initial_stdin}\n`);
      }

      await new Promise((r) => setTimeout(r, 400));
      const { text, nextOffset, running } = readResult(term, 0);
      const header = `Spawned terminal #${term.id} (${running ? "running" : "already exited"}). Use write_stdin to interact, read_terminal(terminal_id=${term.id}, since=${nextOffset}) for more output.`;
      return {
        content: [{ type: "text", text: `${header}\n\n--- initial output ---\n${text || "(no output yet)"}` }],
        details: { terminal_id: term.id, running, next_offset: nextOffset },
      };
    },
  });

  pi.registerTool({
    name: "write_stdin",
    label: "Write Stdin",
    description:
      "Send input to a running background terminal's stdin, then return output produced since the last read. " +
      "Use for interactive processes started with spawn_terminal (REPL commands, debugger input, answering prompts). " +
      "press_enter defaults to true; set false to write raw text without a newline (e.g. control chars like \\u0003 for Ctrl+C).",
    parameters: Type.Object({
      terminal_id: Type.Number({ description: "Id returned by spawn_terminal" }),
      input: Type.String({ description: "Text to write to stdin" }),
      press_enter: Type.Optional(Type.Boolean({ description: "Append a newline after input (default true)", default: true })),
      settle_ms: Type.Optional(
        Type.Number({ description: "How long to wait for output after writing, ms (default 750)", default: 750 }),
      ),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const term = getTerminal(params);
      if (term.proc.exitCode !== null) {
        const { text } = terminalOutput(term, term.cursor);
        throw new Error(`Terminal #${term.id} already exited (code ${term.proc.exitCode}). Recent output:\n${truncate(text, 4000)}`);
      }
      if (!term.proc.stdin?.writable) {
        throw new Error(`Terminal #${term.id} stdin is not writable.`);
      }
      term.proc.stdin.write(params.input + (params.press_enter === false ? "" : "\n"));
      const settle = Math.max(50, Math.min(params.settle_ms ?? 750, 10000));
      await new Promise((r) => setTimeout(r, settle));
      const { text, nextOffset, running } = readResult(term, term.cursor);
      return {
        content: [
          {
            type: "text",
            text: `Terminal #${term.id} ${running ? "running" : "exited"} (read up to offset ${nextOffset}):\n${text || "(no new output)"}`,
          },
        ],
        details: { terminal_id: term.id, running, next_offset: nextOffset },
      };
    },
  });

  pi.registerTool({
    name: "read_terminal",
    label: "Read Terminal",
    description:
      "Read accumulated output from a background terminal. Pass since=next_offset from the previous read to get only new output; omit since to read from the beginning.",
    parameters: Type.Object({
      terminal_id: Type.Number({ description: "Id returned by spawn_terminal" }),
      since: Type.Optional(Type.Number({ description: "Byte offset to read from (default 0)" })),
      settle_ms: Type.Optional(Type.Number({ description: "Wait this long for fresh output first, ms (default 0)", default: 0 })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const term = getTerminal(params);
      const settle = Math.max(0, Math.min(params.settle_ms ?? 0, 10000));
      if (settle > 0) await new Promise((r) => setTimeout(r, settle));
      const from = params.since ?? 0;
      const { text, nextOffset, running, exitCode } = readResult(term, Math.max(from, term.dropped));
      return {
        content: [
          {
            type: "text",
            text: `Terminal #${term.id} ${running ? "running" : `exited(${exitCode})`} output since ${from}:\n${text || "(no output in range)"}`,
          },
        ],
        details: { terminal_id: term.id, running, next_offset: nextOffset },
      };
    },
  });

  pi.registerTool({
    name: "list_terminals",
    label: "List Terminals",
    description: "List all background terminals with their status.",
    parameters: Type.Object({}),

    async execute(): Promise<AgentToolResult<unknown>> {
      if (terminals.size === 0) {
        return { content: [{ type: "text", text: "No background terminals." }], details: { count: 0 } };
      }
      const lines = [...terminals.values()].map(statusLine).join("\n");
      return { content: [{ type: "text", text: lines }], details: { count: terminals.size } };
    },
  });

  pi.registerTool({
    name: "kill_terminal",
    label: "Kill Terminal",
    description: "Terminate a background terminal (SIGTERM, then SIGKILL after 2s).",
    parameters: Type.Object({
      terminal_id: Type.Number({ description: "Id returned by spawn_terminal" }),
      wait_ms: Type.Optional(Type.Number({ description: "Wait this long for exit confirmation (default 500)", default: 500 })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const term = getTerminal(params);
      killTerminal(term);
      const wait = Math.max(0, Math.min(params.wait_ms ?? 500, 5000));
      await new Promise((r) => setTimeout(r, wait));
      const exited = term.proc.exitCode !== null;
      return {
        content: [
          { type: "text", text: `Terminal #${term.id}: ${exited ? `terminated (code ${term.proc.exitCode})` : "termination signal sent, still shutting down"}` },
        ],
        details: { terminal_id: term.id, exited },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    for (const term of terminals.values()) {
      if (term.proc.exitCode === null) {
        try {
          killTerminal(term);
        } catch {
          /* already dead */
        }
      }
    }
    terminals = new Map();
    nextId = 1;
  });

  pi.registerCommand("terminals", {
    description: "Show background terminals",
    handler: async (_args, ctx) => {
      if (terminals.size === 0) {
        ctx.ui.notify("No background terminals.", "info");
        return;
      }
      ctx.ui.notify([...terminals.values()].map(statusLine).join("\n"), "info");
    },
  });
}
