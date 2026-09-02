# pi-extended

A [pi](https://github.com/earendil-works/pi) package that turns the minimal coding harness into a
fully-loaded agent: web search with fallback, background terminals, image viewing, an all-in-one
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

## Tools

| Tool | What it does |
|------|--------------|
| `search` | Web search with a 7-engine fallback chain: DuckDuckGo → Bing → Brave → Mojeek → SearXNG → **Tavily API** (`TAVILY_API_KEY`). First engine with results wins; `engine:` forces one. |
| `web_run` | One tool for the whole web: `search`, `open` (page → text + numbered links), `click` (follow link), `find` (regex within page), `image_search` (DDG/Tavily, optional inline download for VLMs), `pdf` (render pages to PNG + text via poppler), `weather` (wttr.in), `finance` (Yahoo → Google Finance → CoinGecko fallbacks), `sports` (ESPN scoreboards/standings, 17 league presets), `time` (per-timezone). |
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

- Custom footer: session tokens ↑↓, cost, git branch, model, running subagents, active goals
- Rainbow spinner while the agent works, turn counter in the status line
- Model change notifications
- Widgets: active goals (from `goals.ts`)

## Environment & optional dependencies

| Thing | Needed for | Fallback without it |
|-------|-----------|--------------------|
| `TAVILY_API_KEY` | Tavily search/image backup | DuckDuckGo only |
| `poppler-utils` (`sudo apt install poppler-utils`) | `web_run pdf` page rendering | error message suggesting install |

Zero npm runtime dependencies — everything is Node built-ins + fetch.

## Notes

- Background terminals and subagents are children of the pi process; they're terminated on
  `/new`, `/resume`, and quit. Agent *sessions* survive, so `spawn_agent` with the same name
  continues where it left off.
- - Old `v0.1.0` project-persistent goals in `.pi/goals.json` are ignored by v0.1.2+; delete the file if you don't need it.
- Agent state lives in `~/.pi/agent/pi-extended-agents.json`, agent sessions in
  `~/.pi/agent/pi-extended-agent-sessions/<name>/`.
- Subagents don't see your conversation — pass complete, self-contained tasks. They run with the
  same model unless `model`/`thinking` overrides are given, and can be restricted with `tools`.

## Development

```bash
npm install
npx tsc --noEmit     # typecheck against real pi types
node smoke-test.mjs  # loads every extension via jiti + exercises tools end-to-end
```

## Layout

```
extensions/
├── lib.ts          # shared utils (not an extension)
├── web-search.ts   # search (DDG + Tavily)
├── web-run.ts      # web_run composite tool
├── terminals.ts    # background terminals + write_stdin
├── view-image.ts   # view_image for VLMs
├── goals.ts        # goal_* tools + /goals + widget
├── agents.ts       # spawn/message/wait/kill subagents
└── ui.ts           # footer, spinner, status line
```

MIT
