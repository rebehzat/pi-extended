import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RAINBOW = [
  "\x1b[38;2;255;179;186m",
  "\x1b[38;2;255;223;186m",
  "\x1b[38;2;255;255;186m",
  "\x1b[38;2;186;255;201m",
  "\x1b[38;2;186;225;255m",
  "\x1b[38;2;218;186;255m",
];
const RESET_FG = "\x1b[39m";

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60 ? `${m % 60}m` : ""}` : `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ""}`;
}

function homeRelative(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const rel = path.relative(home, cwd);
  if (rel === "") return "~";
  return rel.startsWith("..") || path.isAbsolute(rel) ? cwd : `~${path.sep}${rel}`;
}

/**
 * `left` and `right` on one line, right-aligned, never wider than `width` (pi-tui aborts on over-wide lines).
 * When both don't fit, the side named by `keep` stays whole (if it can) and the other one is shortened.
 */
function row(left: string, right: string, width: number, ellipsis: string, keep: "left" | "right" = "left"): string {
  const inner = Math.max(0, width - 2);
  if (!right) return ` ${truncateToWidth(left, inner, ellipsis)} `;
  if (visibleWidth(left) + 2 + visibleWidth(right) > inner) {
    if (keep === "right") {
      right = truncateToWidth(right, inner, ellipsis);
      const room = inner - visibleWidth(right) - 2;
      left = room > 3 ? truncateToWidth(left, room, ellipsis) : "";
    } else {
      left = truncateToWidth(left, inner, ellipsis);
      const room = inner - visibleWidth(left) - 2;
      right = room > 8 ? truncateToWidth(right, room, ellipsis) : "";
    }
  }
  const gap = Math.max(0, inner - visibleWidth(left) - visibleWidth(right));
  return truncateToWidth(` ${left}${" ".repeat(gap)}${right} `, width, "");
}

function runningAgents(): number {
  try {
    const stateFile = path.join(getAgentDir(), "pi-extended-agents.json");
    if (!fs.existsSync(stateFile)) return 0;
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      agents?: Record<string, { status?: string }>;
    };
    return Object.values(state.agents ?? {}).filter((a) => a.status === "running").length;
  } catch {
    return 0;
  }
}

function activeGoals(ctx: ExtensionContext): number {
  try {
    let latest: { goals?: Array<{ status?: string }> } | undefined;
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type === "custom" && e.customType === "pi-extended-goals") {
        latest = e.data as { goals?: Array<{ status?: string }> };
      }
    }
    return (latest?.goals ?? []).filter((g) => g.status === "active").length;
  } catch {
    return 0;
  }
}

export default function (pi: ExtensionAPI) {
  let footerEnabled = false;
  let turnCount = 0;
  // The footer reads the current session through this, so it follows /new, /resume and forks.
  let ctxRef: ExtensionContext | undefined;
  let requestRender: (() => void) | undefined;

  const sessionStats = (ctx: ExtensionContext) => {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHit: undefined as number | undefined, started: undefined as number | undefined };
    const add = (u: any) => {
      if (!u) return;
      t.input += u.input ?? 0;
      t.output += u.output ?? 0;
      t.cacheRead += u.cacheRead ?? 0;
      t.cacheWrite += u.cacheWrite ?? 0;
      t.cost += u.cost?.total ?? 0;
    };
    try {
      // All entries, like pi's own footer: usage from compactions and abandoned branches still cost money.
      for (const e of ctx.sessionManager.getEntries() as any[]) {
        if (t.started === undefined && e.timestamp) t.started = Date.parse(e.timestamp);
        if (e.type === "usage") add(e.usage);
        else if (e.type === "message" && e.message.role === "assistant") {
          const u = (e.message as AssistantMessage).usage;
          add(u);
          const prompt = u.input + u.cacheRead + u.cacheWrite;
          t.cacheHit = prompt > 0 ? (u.cacheRead / prompt) * 100 : undefined;
        } else if (e.type === "message" && e.message.role === "toolResult" && e.message.usage) add(e.message.usage);
        else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) add(e.usage);
      }
    } catch {
      /* no session data yet */
    }
    return t;
  };

  const installFooter = (ctx: ExtensionContext) => {
    try {
      ctx.ui.setFooter((tui, theme, footerData) => {
        requestRender = () => tui.requestRender();
        const unsub = footerData.onBranchChange(() => tui.requestRender());
        // Keep the session clock ticking while idle.
        const timer = setInterval(() => tui.requestRender(), 30_000);
        timer.unref?.();
        const sep = theme.fg("dim", " │ ");
        const ellipsis = theme.fg("dim", "…");
        return {
          dispose() {
            unsub();
            clearInterval(timer);
            requestRender = undefined;
          },
          invalidate() {},
          render(width: number): string[] {
            const c = ctxRef ?? ctx;
            const st = sessionStats(c);

            // Line 1: where we are, and how full the context is.
            // Branch first, so a long path gets shortened instead of hiding it.
            const branch = footerData.getGitBranch();
            let where = `${branch ? `${theme.fg("accent", `⎇ ${branch}`)} ` : ""}${theme.fg("dim", homeRelative(c.cwd))}`;
            let name: string | undefined;
            try {
              name = c.sessionManager.getSessionName();
            } catch {}
            if (name) where += theme.fg("dim", ` • ${name}`);

            let context = "";
            try {
              const usage = c.getContextUsage();
              const windowSize = usage?.contextWindow ?? c.model?.contextWindow ?? 0;
              if (windowSize > 0) {
                const pct = usage?.percent ?? null;
                const color = pct === null ? "dim" : pct > 90 ? "error" : pct > 70 ? "warning" : "success";
                const cells = 10;
                const filled = pct === null ? 0 : Math.min(cells, Math.round((pct / 100) * cells));
                const bar = theme.fg(color, "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(cells - filled));
                const amount =
                  pct === null
                    ? theme.fg("dim", `?/${fmtTokens(windowSize)}`)
                    : `${theme.fg(color, `${pct.toFixed(0)}%`)} ${theme.fg("dim", `${fmtTokens(usage?.tokens ?? 0)}/${fmtTokens(windowSize)}`)}`;
                context = `${theme.fg("dim", "ctx")} ${bar} ${amount}`;
              }
            } catch {}

            // Line 2: usage and activity on the left, model and thinking on the right.
            const tokens = [`↑${fmtTokens(st.input)}`, `↓${fmtTokens(st.output)}`];
            if (st.cacheRead || st.cacheWrite) {
              tokens.push(`⟳${fmtTokens(st.cacheRead)}`);
              if (st.cacheHit !== undefined) tokens.push(`${st.cacheHit.toFixed(0)}% hit`);
            }
            const left = [theme.fg("dim", tokens.join(" ")), theme.fg("dim", `$${st.cost.toFixed(3)}`)];
            const agents = runningAgents();
            if (agents > 0) left.push(`${theme.fg("warning", "⧗")} ${agents} agent${agents > 1 ? "s" : ""}`);
            const goals = activeGoals(c);
            if (goals > 0) left.push(`${theme.fg("success", "◎")} ${goals} goal${goals > 1 ? "s" : ""}`);
            const activity = [turnCount ? `${turnCount} turn${turnCount === 1 ? "" : "s"}` : "", st.started ? `⏱ ${fmtDuration(Date.now() - st.started)}` : ""]
              .filter(Boolean)
              .join(" ");
            if (activity) left.push(theme.fg("dim", activity));

            let model = theme.fg("dim", c.model ? `${c.model.provider}/${c.model.id}` : "no model");
            if (c.model?.reasoning) {
              const level = pi.getThinkingLevel() || "off";
              let paint = (s: string) => theme.fg("dim", s);
              try {
                paint = theme.getThinkingBorderColor(level as any);
              } catch {}
              model += `${theme.fg("dim", " • ")}${paint(level === "off" ? "thinking off" : level)}`;
            }

            const lines = [row(where, context, width, ellipsis, "right"), row(left.join(sep), model, width, ellipsis)];

            // Line 3: statuses other extensions publish via ctx.ui.setStatus(), sorted by key like the built-in footer.
            const statuses = [...footerData.getExtensionStatuses().entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => text.replace(/[\r\n\t]+/g, " ").trim())
              .filter(Boolean);
            if (statuses.length > 0) lines.push(truncateToWidth(` ${statuses.join(sep)}`, width, ellipsis));
            return lines;
          },
        };
      });
    } catch {
      /* footer unavailable (print/json mode) */
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    turnCount = 0;
    ctxRef = ctx;
    if (!footerEnabled) {
      footerEnabled = true;
      installFooter(ctx);
    }
    requestRender?.();
  });

  pi.registerCommand("ui", {
    description: "Toggle the pi-extended footer: /ui on|off",
    getArgumentCompletions: (prefix: string) =>
      ["on", "off"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      ctxRef = ctx;
      if (arg === "off") {
        footerEnabled = false;
        try {
          ctx.ui.setFooter(undefined);
        } catch {
          /* ignore */
        }
        ctx.ui.notify("pi-extended footer off", "info");
        return;
      }
      if (arg === "on" || !footerEnabled) {
        footerEnabled = true;
        installFooter(ctx);
        ctx.ui.notify("pi-extended footer on", "info");
        return;
      }
      ctx.ui.notify(`pi-extended footer: ${footerEnabled ? "on" : "off"}`, "info");
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    turnCount++;
    try {
      ctx.ui.setWorkingIndicator({
        frames: SPINNER_FRAMES.map((f, i) => `${RAINBOW[i % RAINBOW.length]}${f}${RESET_FG}`),
        intervalMs: 80,
      });
    } catch {
      /* ui unavailable */
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      ctx.ui.setWorkingIndicator(undefined);
    } catch {
      /* ignore */
    }
    requestRender?.();
  });

  // The footer reads thinking and model live; just redraw.
  pi.on("thinking_level_select", async () => requestRender?.());

  pi.on("model_select", async (event, ctx) => {
    requestRender?.();
    if (event.source !== "restore") {
      ctx.ui.notify(`Model: ${event.model.provider}/${event.model.id}`, "info");
    }
  });
}
