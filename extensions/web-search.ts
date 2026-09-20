import { homedir } from "node:os";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchWithTimeout, serializeError, truncate } from "./lib.ts";

export interface SearchResult { title: string; url: string; snippet: string; source: string; }
const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";
const TINYFISH_KEY_FILE = join(homedir(), ".pi", "agent", "tinyfish.json");

async function readTinyFishKeyFile(): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(TINYFISH_KEY_FILE, "utf8")) as { apiKey?: unknown };
    return typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey.trim() : undefined;
  } catch { return undefined; }
}

export async function resolveTinyFishKey(): Promise<string | undefined> {
  return process.env.TINYFISH_API_KEY?.trim() || readTinyFishKeyFile();
}

async function saveTinyFishKey(apiKey: string): Promise<void> {
  await mkdir(dirname(TINYFISH_KEY_FILE), { recursive: true, mode: 0o700 });
  await writeFile(TINYFISH_KEY_FILE, `${JSON.stringify({ apiKey: apiKey.trim() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(TINYFISH_KEY_FILE, 0o600);
}

async function clearTinyFishKey(): Promise<void> { await saveTinyFishKey(""); }

export async function tinyFishSearch(query: string, cap: number, apiKey: string): Promise<SearchResult[]> {
  const url = new URL(TINYFISH_SEARCH_URL);
  url.searchParams.set("query", query);
  const res = await fetchWithTimeout(url.toString(), { method: "GET", headers: { accept: "application/json", "x-api-key": apiKey }, timeoutMs: 20000 });
  if (!res.ok) {
    const body = (await res.text()).replace(/\s+/g, " ").slice(0, 240);
    throw new Error(`TinyFish HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; snippet?: string; date?: string }> };
  return (data.results ?? []).filter((r) => typeof r.url === "string" && /^https?:\/\//i.test(r.url)).slice(0, cap).map((r) => ({
    title: r.title?.trim() || r.url!, url: r.url!,
    snippet: [r.snippet?.trim(), r.date ? `(${r.date})` : ""].filter(Boolean).join(" "), source: "tinyfish",
  }));
}

export interface SearchOutcome { results: SearchResult[]; engine?: string; errors: string[]; }
export async function searchWeb(query: string, cap: number): Promise<SearchOutcome> {
  const apiKey = await resolveTinyFishKey();
  if (!apiKey) return { results: [], errors: ["TinyFish API key is not configured"] };
  try { return { results: await tinyFishSearch(query, cap, apiKey), engine: "tinyfish", errors: [] }; }
  catch (error) { return { results: [], engine: "tinyfish", errors: [serializeError(error)] }; }
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results.map((r, i) => { const lines = [`${i + 1}. ${r.title}`, `   ${r.url}`]; if (r.snippet) lines.push(`   ${truncate(r.snippet, 300)}`); return lines.join("\n"); }).join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tinyfish-key", {
    description: "Set, clear, or check the TinyFish API key stored for Pi",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "clear") { await clearTinyFishKey(); ctx.ui.notify("TinyFish API key cleared.", "info"); return; }
      if (action === "status") { ctx.ui.notify((await resolveTinyFishKey()) ? "TinyFish API key is configured." : "TinyFish API key is not configured.", "info"); return; }
      const apiKey = await ctx.ui.input("TinyFish API key", "Paste the key from agent.tinyfish.ai (input is not saved to the session)");
      if (!apiKey?.trim()) { ctx.ui.notify("No key entered; nothing changed.", "warning"); return; }
      await saveTinyFishKey(apiKey);
      ctx.ui.notify("TinyFish API key saved in Pi's private agent config.", "info");
    },
  });

  pi.registerTool({
    name: "search", label: "Search", description: "Search the live web with TinyFish and return structured title, URL, and snippet results.",
    promptSnippet: "Search the live web with TinyFish", promptGuidelines: ["Use search for current web information such as docs, releases, news, and error messages."],
    parameters: Type.Object({ query: Type.String({ description: "Search query" }), max_results: Type.Optional(Type.Number({ description: "Max results to return (default 6, max 20)", default: 6 })) }),
    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const cap = Math.max(1, Math.min(params.max_results ?? 6, 20));
      const outcome = await searchWeb(params.query, cap);
      if (outcome.results.length === 0) {
        const hint = outcome.errors[0] === "TinyFish API key is not configured" ? " Run /tinyfish-key inside Pi to configure it." : "";
        return { content: [{ type: "text", text: `No results for: ${params.query}.${hint}${outcome.errors.length ? ` (${outcome.errors.join("; ")})` : ""}` }], details: { query: params.query, errors: outcome.errors } };
      }
      return { content: [{ type: "text", text: `${outcome.results.length} results for "${params.query}" via TinyFish:\n\n${formatResults(outcome.results)}` }], details: { query: params.query, engine: "tinyfish", results: outcome.results } };
    },
  });
}
