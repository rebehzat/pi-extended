import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { nowIso } from "./lib.ts";

type GoalStatus = "active" | "done" | "dropped" | "blocked";
type Priority = "low" | "medium" | "high";

interface GoalNote {
  ts: string;
  text: string;
}

interface Goal {
  id: number;
  title: string;
  description?: string;
  status: GoalStatus;
  priority: Priority;
  parent_id?: number;
  notes: GoalNote[];
  created_at: string;
  updated_at: string;
  finished_at?: string;
}

interface GoalStore {
  nextId: number;
  goals: Goal[];
}

const ENTRY_TYPE = "pi-extended-goals";

let store: GoalStore = { nextId: 1, goals: [] };

function persist(pi: ExtensionAPI): void {
  pi.appendEntry(ENTRY_TYPE, store);
}

function restore(ctx: ExtensionContext): void {
  store = { nextId: 1, goals: [] };
  try {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        const data = entry.data as GoalStore | undefined;
        if (data && Array.isArray(data.goals) && typeof data.nextId === "number") {
          store = { nextId: data.nextId, goals: data.goals };
        }
      }
    }
  } catch {
    /* fresh session */
  }
}

function formatGoal(g: Goal): string {
  const icon = g.status === "active" ? "[ ]" : g.status === "blocked" ? "[!]" : g.status === "done" ? "[x]" : "[-]";
  const parts = [`${icon} #${g.id} (${g.priority}) ${g.title}`];
  if (g.description) parts.push(`      ${g.description}`);
  if (g.parent_id) parts.push(`      parent: #${g.parent_id}`);
  for (const n of g.notes.slice(-2)) parts.push(`      note ${n.ts}: ${n.text}`);
  parts.push(`      status: ${g.status}${g.finished_at ? ` (finished ${g.finished_at})` : ""} | updated ${g.updated_at}`);
  return parts.join("\n");
}

function statusWidget(goals: Goal[]): string[] {
  const active = goals.filter((g) => g.status === "active");
  const blocked = goals.filter((g) => g.status === "blocked");
  const done = goals.filter((g) => g.status === "done");
  const lines = [`goals: ${active.length} active, ${blocked.length} blocked, ${done.length} done`];
  for (const g of active.slice(0, 3)) lines.push(`  #${g.id} ${g.title}`);
  if (active.length > 3) lines.push(`  ... +${active.length - 3} more`);
  return lines;
}

function getGoal(id: number): Goal {
  const goal = store.goals.find((g) => g.id === id);
  if (!goal) throw new Error(`Goal #${id} not found in this session. Use goal_list.`);
  return goal;
}

export default function (pi: ExtensionAPI) {
  const updateWidget = (ctx: ExtensionContext) => {
    try {
      ctx.ui?.setWidget?.("goals", statusWidget(store.goals));
    } catch {
      /* widget optional */
    }
  };

  pi.registerTool({
    name: "goal_create",
    label: "Goal Create",
    description:
      "Create a goal tracked for the CURRENT SESSION (not persisted across sessions; /new starts a clean slate). " +
      "Use for multi-step objectives within this conversation; optionally link child goals with parent_id.",
    promptSnippet: "Create a session-scoped tracked goal",
    promptGuidelines: [
      "Use goal_create when the user defines an objective to track; keep goals updated with goal_update as work progresses and close them with goal_finish.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short goal title" }),
      description: Type.Optional(Type.String({ description: "Details, acceptance criteria, or plan" })),
      priority: Type.Optional(StringEnum(["low", "medium", "high"] as const, { description: "Default: medium", default: "medium" })),
      parent_id: Type.Optional(Type.Number({ description: "Optional parent goal id for sub-goals" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (params.parent_id && !store.goals.some((g) => g.id === params.parent_id)) {
        throw new Error(`Parent goal #${params.parent_id} not found.`);
      }
      const goal: Goal = {
        id: store.nextId++,
        title: params.title,
        description: params.description,
        status: "active",
        priority: params.priority ?? "medium",
        parent_id: params.parent_id,
        notes: [],
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      store.goals.push(goal);
      persist(pi);
      updateWidget(ctx);
      return {
        content: [{ type: "text", text: `Created goal #${goal.id}: ${goal.title}\n\n${formatGoal(goal)}` }],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "goal_update",
    label: "Goal Update",
    description:
      "Update a session goal: change status (active/blocked/done/dropped), title, description, priority, or append a progress note.",
    parameters: Type.Object({
      id: Type.Number({ description: "Goal id" }),
      status: Type.Optional(StringEnum(["active", "blocked", "done", "dropped"] as const)),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
      note: Type.Optional(Type.String({ description: "Append a timestamped progress note" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const goal = getGoal(params.id);
      if (params.title !== undefined) goal.title = params.title;
      if (params.description !== undefined) goal.description = params.description;
      if (params.priority !== undefined) goal.priority = params.priority;
      if (params.status !== undefined) {
        goal.status = params.status;
        if (params.status === "done" || params.status === "dropped") goal.finished_at = nowIso();
        else goal.finished_at = undefined;
      }
      if (params.note) goal.notes.push({ ts: nowIso(), text: params.note });
      goal.updated_at = nowIso();
      persist(pi);
      updateWidget(ctx);
      return {
        content: [{ type: "text", text: `Updated goal #${goal.id}.\n\n${formatGoal(goal)}` }],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "goal_finish",
    label: "Goal Finish",
    description: "Mark a session goal as done, optionally recording a completion summary. Active child goals are closed too.",
    parameters: Type.Object({
      id: Type.Number({ description: "Goal id" }),
      summary: Type.Optional(Type.String({ description: "Completion summary appended as a note" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const goal = getGoal(params.id);
      goal.status = "done";
      goal.finished_at = nowIso();
      goal.updated_at = nowIso();
      if (params.summary) goal.notes.push({ ts: nowIso(), text: `summary: ${params.summary}` });
      const children = store.goals.filter((g) => g.parent_id === goal.id && g.status === "active");
      for (const child of children) {
        child.status = "done";
        child.finished_at = nowIso();
        child.updated_at = nowIso();
      }
      persist(pi);
      updateWidget(ctx);
      const extra = children.length > 0 ? `\nAlso closed child goals: ${children.map((c) => `#${c.id}`).join(", ")}` : "";
      return {
        content: [{ type: "text", text: `Finished goal #${goal.id}: ${goal.title}${extra}\n\n${formatGoal(goal)}` }],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "goal_list",
    label: "Goal List",
    description: "List this session's goals, optionally filtered by status.",
    parameters: Type.Object({
      status: Type.Optional(StringEnum(["active", "blocked", "done", "dropped", "all"] as const, { description: "Default: all", default: "all" })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const filter = params.status ?? "all";
      const goals = filter === "all" ? store.goals : store.goals.filter((g) => g.status === filter);
      if (goals.length === 0) {
        return {
          content: [{ type: "text", text: `No ${filter === "all" ? "" : `${filter} `}goals in this session yet.` }],
          details: { goals: [] },
        };
      }
      return {
        content: [{ type: "text", text: `Goals (${filter}, ${goals.length}):\n\n${goals.map(formatGoal).join("\n\n")}` }],
        details: { goals },
      };
    },
  });

  pi.registerCommand("goals", {
    description: "Show this session's goals",
    getArgumentCompletions: (prefix: string) =>
      ["all", "active", "blocked", "done", "dropped"]
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const status = (args || "all").trim() as GoalStatus | "all";
      const goals = status === "all" ? store.goals : store.goals.filter((g) => g.status === status);
      ctx.ui.notify(goals.length === 0 ? "No goals in this session yet." : `Goals (${status}):\n\n${goals.map(formatGoal).join("\n\n")}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
    try {
      ctx.ui?.setWidget?.("goals", store.goals.length > 0 ? statusWidget(store.goals) : []);
    } catch {
      /* widget optional */
    }
  });
}
