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
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
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
  let currentModel = "no-model";

  const sessionStats = (ctx: ExtensionContext) => {
    let input = 0;
    let output = 0;
    let cost = 0;
    try {
      for (const e of ctx.sessionManager.getBranch()) {
        if (e.type === "message" && e.message.role === "assistant") {
          const m = e.message as AssistantMessage;
          input += m.usage.input;
          output += m.usage.output;
          cost += m.usage.cost.total;
        }
      }
    } catch {
      /* no session data yet */
    }
    return { input, output, cost };
  };

  const installFooter = (ctx: ExtensionContext) => {
    try {
      ctx.ui.setFooter((tui, theme, footerData) => {
        const unsub = footerData.onBranchChange(() => tui.requestRender());
        return {
          dispose: unsub,
          invalidate() {},
          render(width: number): string[] {
            const { input, output, cost } = sessionStats(ctx);
            const branch = footerData.getGitBranch();

            const extras: string[] = [];
            const agents = runningAgents();
            if (agents > 0) extras.push(`${theme.fg("warning", "⧗")} ${agents} agent${agents > 1 ? "s" : ""}`);
            const goals = activeGoals(ctx);
            if (goals > 0) extras.push(`${theme.fg("success", "◎")} ${goals} goal${goals > 1 ? "s" : ""}`);

            const left = [
              theme.fg("dim", `↑${fmtTokens(input)} ↓${fmtTokens(output)}`),
              theme.fg("dim", `$${cost.toFixed(3)}`),
              ...extras,
            ].join(theme.fg("dim", " │ "));

            const right = [branch ? theme.fg("accent", branch) : "", theme.fg("dim", currentModel)]
              .filter(Boolean)
              .join(theme.fg("dim", " │ "));

            const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2));
            return [truncateToWidth(` ${left}${pad}${right} `, width)];
          },
        };
      });
    } catch {
      /* footer unavailable (print/json mode) */
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    turnCount = 0;
    if (ctx.model) currentModel = `${ctx.model.provider}/${ctx.model.id}`;
    try {
      ctx.ui.setStatus("pi-extended", ctx.ui.theme.fg("dim", "⚡ pi-extended"));
    } catch {
      /* ignore */
    }
    if (!footerEnabled) {
      footerEnabled = true;
      installFooter(ctx);
    }
  });

  pi.registerCommand("ui", {
    description: "Toggle the pi-extended footer: /ui on|off",
    getArgumentCompletions: (prefix: string) =>
      ["on", "off"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
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
      const accent = ctx.ui.theme.fg("accent", "⟨");
      const dim = ctx.ui.theme.fg("dim", ` turn ${turnCount} `);
      ctx.ui.setStatus("pi-extended", `${accent}${dim}${ctx.ui.theme.fg("accent", "⟩")}`);
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
      const ok = ctx.ui.theme.fg("success", "✓");
      const dim = ctx.ui.theme.fg("dim", ` ${turnCount} turn${turnCount === 1 ? "" : "s"}`);
      ctx.ui.setStatus("pi-extended", `${ok}${dim}`);
    } catch {
      /* ignore */
    }
  });

  pi.on("model_select", async (event, ctx) => {
    currentModel = `${event.model.provider}/${event.model.id}`;
    if (event.source !== "restore") {
      ctx.ui.notify(`Model: ${currentModel}`, "info");
    }
  });
}
