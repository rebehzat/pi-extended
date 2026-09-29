# pi-extended

A [pi](https://github.com/earendil-works/pi) package that turns the minimal coding harness into a
fully-loaded agent: TinyFish web search, background terminals, image viewing, an all-in-one
`web_run` tool, persistent goals, and named subagents you can message.

Built entirely as extensions — **pi itself stays stock**, so `pi update` / `pi update --self`
always works without merge conflicts.

## Install

```bash
pi install git:github.com/rebehzat/pi-extended        # global (all projects)
pi install -l git:github.com/rebehzat/pi-extended     # project-local (.pi/)
pi -e git:github.com/rebehzat/pi-extended             # try once, no install
pi install /path/to/this/repo                         # local checkout
```

Then `pi config` lets you toggle any extension off. Update with `pi update --extensions`.

Inside Pi, run `/tinyfish-key` and paste the key from `agent.tinyfish.ai`. Pi stores it in
`~/.pi/agent/tinyfish.json` with owner-only permissions. Use `/tinyfish-key status` to check it
or `/tinyfish-key clear` to remove it. The `TINYFISH_API_KEY` environment variable is supported
as an explicit override for CI and one-off runs.

## Tools

| Tool | What it does |
|------|--------------|
| `search` | Live structured web search through TinyFish (`TINYFISH_API_KEY` or the Pi-managed key). |
| `web_run` | One tool for the whole web: `search`, `open` (page → text + numbered links), `click` (follow link), `find` (regex within page), `image_search` (DuckDuckGo, optional inline download for VLMs), `pdf` (render pages to PNG + text via poppler), `weather` (wttr.in), `finance` (Yahoo → Google Finance → CoinGecko fallbacks), `sports` (ESPN scoreboards/standings, 17 league presets), `time` (per-timezone). |
| `spawn_terminal` | Long-running command in a background terminal (own bash process, stdin/stdout pipes). Returns a terminal id immediately. |
| `write_stdin` | Send input to a running terminal (REPLs, debuggers, prompts) and get new output back. `press_enter: false` for raw control chars. |
| `read_terminal` / `list_terminals` / `kill_terminal` | Poll output by offset, list all terminals, terminate. |
| `view_image` | Attach a local image file or image URL to the conversation for vision models (png/jpeg/gif/webp/bmp, 15MB cap). |
| `goal_create` / `goal_update` / `goal_finish` / `goal_list` | Session-scoped goals — stored in the session (clean slate on `/new`, restored on `/resume`, branch-correct under `/fork`). Priorities, notes, sub-goals (finish cascades to children). Live widget above the editor. |
| `spawn_agent` | Named subagent = separate headless `pi` process with its own session, model, tools, cwd. Runs in background; session kept for follow-ups. |
| `send_message` | Message an agent: queued if busy (delivered when current task ends), instant turn if idle. |
| `followup_task` | Queue follow-up work without blocking. |
| `wait_agent` | Block until an agent (or `"all"`) finishes, get final output. |
| `list_agents` / `kill_agent` | Status board / terminate process (session kept). |

## Commands

`/goals [status]`, `/agents`, `/terminals`, `/ui on|off` (footer toggle)

## UI polish (`ui.ts`)

- Custom footer:
  - line 1: git branch, working directory, session name, and a **context bar** (`ctx ▰▰▰▱▱▱▱▱▱▱ 31% 84k/272k`, green → yellow over 70% → red over 90%)
  - line 2: billed session **plus linked subagent/workflow** tokens ↑↓, cache reads and hit rate, combined cost, running subagents, active goals, turns, session time; model and thinking level (in the thinking colour) on the right
  - line 3: statuses from other extensions (HARDcode, SoftCode, ultracode, …)
  - it follows `/new`, `/resume` and forks, and shortens to fit narrow terminals
- Rainbow spinner while the agent works
- Model change notifications
- Widgets: active goals (from `goals.ts`)

## Piano cost snapshot (RPC integration)

Pi 0.87.1 RPC `setStatus` carries text only, not structured status data. In RPC mode,
pi-extended publishes a structured cost snapshot with
`pi.appendEntry('pi-extended-cost', data)`. Piano should filter RPC `entry_appended`
events for entries whose `customType` is `pi-extended-cost` and read their `data`:

```json
{"type":"entry_appended","entry":{"type":"custom","id":"<Pi entry id>","parentId":"<Pi entry id>","timestamp":"<ISO time>","customType":"pi-extended-cost","data":{"version":1,"sessionId":"<Pi session id>","parent":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},"agents":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},"workflows":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},"total":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},"activeAgents":0}}}
```

Pi supplies the outer entry fields; this is an application-level schema, not a built-in
Pi cost event. The snapshot contains only aggregate billing data:

| Field | Meaning |
|-------|---------|
| `version` | Protocol version, currently `1`. |
| `sessionId` | Parent Pi session ID for matching/rekeying the displayed session. |
| `parent`, `agents`, `workflows`, `total` | Each has numeric `input`, `output`, `cacheRead`, `cacheWrite` token counts and `cost` in USD. |
| `activeAgents` | Integer count of active subagents. |

Use `get_state` to identify the current session ID; when the session changes (including
`/new`, `/resume`, or a fork), rekey the displayed snapshot rather than carrying the old
session's totals forward. Subscribe to `entry_appended` before requesting a session
switch, then call `get_entries` after it and on initial connection or reconnect. Select
the latest matching `pi-extended-cost` entry for the current session; merge the live and
catch-up streams and deduplicate by Pi entry `id` and schema `version`. Use `get_entries`'s
`since` cursor for later catch-up. The initial timer is best effort: there is **no**
guarantee the append arrives after the `new_session` response. If no snapshot exists yet,
wait for the next one (and verify that this extension is loaded). Snapshots contain no
transcript or private fields.

Snapshots refresh on session start, finalized assistant messages, relevant tool results,
agent settlement, compaction and tree navigation. Updates are deduplicated/coalesced;
there are no per-stream writes or continuous child/workflow polls. Child and workflow
charges may only update at completion or another lifecycle event; live intra-run charges
are not guaranteed. RPC scans at most 128 run-directory/metadata candidates per collection;
explicit workflow-result run IDs (and resume ancestors) are resolved directly. Historical
unlinked runs beyond that batch are discovered on later lifecycle events, not guaranteed
in the startup snapshot. Missing `run.json` metadata is retried on later collections even
if the runs directory's mtime has not changed. RPC performs no idle discovery polling.
Custom entries are stored in session history but are non-context (they are not sent
to the model); consumers should account for the session-history storage overhead.

## Piano task progress (RPC integration)

`spawn_agent` and subsequent named-agent turns (`send_message` / `followup_task`)
append `piano-task-progress` custom entries at start, queued-to-running transitions,
finalized assistant usage (100ms coalescing, at most 32 intermediate usage entries
per task), and settlement. A task has a random opaque
`taskId`, `kind: "spawned_agent"`, `version: 1`, the initiating Pi `sessionId`, a generic
`title` (`Agent #N`), lifecycle timestamps, a `status` (`pending`, `running`,
`completed`, `failed`, `cancelled`, or `interrupted`), and cumulative nonnegative
`usage` (`totalTokens`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `costUsd`).
There is no `runId` for standalone agents. No name, prompt, child text/error, path, or PID
is copied to these entries. The existing `pi-extended-cost` producer is independent.

Consumers should filter `entry_appended` / `get_entries` by `customType`, validate the
schema, compare `data.sessionId` with the **active** Pi session, and keep the latest
snapshot by `taskId`. In-flight tasks from a switched-away session never append to the
new session. Entries are event-driven (no child polling or per-token writes); progress
between finalized assistant messages is not guaranteed. This extension does not emit
workflow run/member task entries; those must come from a workflow producer.

## Environment & optional dependencies

| Thing | Needed for | Fallback without it |
|-------|-----------|--------------------|
| `TINYFISH_API_KEY` | Optional environment override for TinyFish search (interactive users should run `/tinyfish-key` in Pi) | Search reports that the key is not configured |
| `poppler-utils` (`sudo apt install poppler-utils`) | `web_run pdf` page rendering | error message suggesting install |

Zero npm runtime dependencies — everything is Node built-ins + fetch.

## Notes

- Background terminals and subagents are children of the pi process; they're terminated on
  `/new`, `/resume`, and quit. Agent *sessions* survive, so `spawn_agent` with the same name
  continues where it left off.
- - Old `v0.1.0` project-persistent goals in `.pi/goals.json` are ignored by v0.1.2+; delete the file if you don't need it.
- Agent state lives in `~/.pi/agent/pi-extended-agents.json`, agent sessions in
  `~/.pi/agent/pi-extended-agent-sessions/<name>/`. New turns also save parent-session attribution windows there so reusing a named agent in another session does not transfer its charges. Historical turns without a matching session-owned accounting window have unknown ownership and are excluded from billed totals, not assigned by agent name.
- The footer bills persisted Pi session entries (all branches), not streaming agent summaries, workflow results, or replayed workflow journals. It also reads linked workflow child sessions under `~/.pi/agent/ultracode/runs/<id>/agents/`; a workflow attempt whose session directory was deleted on retry cannot be recovered. Parent tool results that already report usage are not billed again from the linked child.
- Subagents don't see your conversation — pass complete, self-contained tasks. They run with the
  same model unless `model`/`thinking` overrides are given, and can be restricted with `tools`.

## Development

```bash
npm install
npx tsc --noEmit        # typecheck against real pi types
node --test usage-test.mjs # offline session-accounting fixtures
node smoke-test.mjs     # loads every extension via jiti + exercises tools end-to-end
```

## Layout

```
extensions/
├── lib.ts          # shared utils (not an extension)
├── usage.ts        # session and child accounting (not an extension)
├── web-search.ts   # TinyFish search + /tinyfish-key setup
├── web-run.ts      # web_run composite tool
├── terminals.ts    # background terminals + write_stdin
├── view-image.ts   # view_image for VLMs
├── goals.ts        # goal_* tools + /goals + widget
├── agents.ts       # spawn/message/wait/kill subagents
└── ui.ts           # footer, spinner, status line
```

MIT
