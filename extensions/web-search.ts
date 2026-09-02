import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decodeEntities, fetchWithTimeout, serializeError, stripTags, truncate } from "./lib.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: "duckduckgo" | "tavily";
}

function decodeDdgHref(href: string): string {
  let url = decodeEntities(href);
  if (url.startsWith("//")) url = `https:${url}`;
  const uddg = url.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      url = decodeURIComponent(uddg[1]);
    } catch {
      /* keep raw */
    }
  }
  return url;
}

function parseDdgHtml(html: string, cap: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/class="(?:result|web-result)"/i).slice(1);
  for (const block of blocks) {
    if (results.length >= cap) break;
    const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = decodeDdgHref(linkMatch[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(stripTags(linkMatch[2])).replace(/\s+/g, " ").trim();
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snippetMatch ? decodeEntities(stripTags(snippetMatch[1])).replace(/\s+/g, " ").trim() : "";
    results.push({ title, url, snippet, source: "duckduckgo" });
  }
  return results;
}

export async function duckDuckGoSearch(query: string, cap: number): Promise<SearchResult[]> {
  for (const endpoint of ["https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"]) {
    try {
      const res = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ q: query }).toString(),
        timeoutMs: 15000,
      });
      if (!res.ok) continue;
      const html = await res.text();
      const results = parseDdgHtml(html, cap);
      if (results.length > 0) return results;
    } catch {
      continue;
    }
  }
  return [];
}

export async function tavilySearch(query: string, cap: number, apiKey: string): Promise<SearchResult[]> {
  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: cap, search_depth: "basic" }),
    timeoutMs: 20000,
  });
  if (!res.ok) {
    throw new Error(`Tavily HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? [])
    .filter((r) => r.url)
    .slice(0, cap)
    .map((r) => ({
      title: r.title ?? r.url!,
      url: r.url!,
      snippet: (r.content ?? "").replace(/\s+/g, " ").trim(),
      source: "tavily" as const,
    }));
}

export function resolveTavilyKey(): string | undefined {
  return process.env.TAVILY_API_KEY || undefined;
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title}`, `   ${r.url}`];
      if (r.snippet) lines.push(`   ${truncate(r.snippet, 300)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Search",
    description:
      "Web search returning a list of {title, url, snippet}. Uses DuckDuckGo (html endpoint) and automatically falls back " +
      "to the Tavily API when TAVILY_API_KEY is set and DuckDuckGo fails or returns nothing. Set engine to force a backend.",
    promptSnippet: "Search the web: returns title/url/snippet results for a query",
    promptGuidelines: [
      "Use search when you need current web information (docs, releases, news, error messages). Combine with web_run open to read a full page.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      max_results: Type.Optional(
        Type.Number({ description: "Max results to return (default 6, max 20)", default: 6 }),
      ),
      engine: Type.Optional(
        StringEnum(["auto", "duckduckgo", "tavily"] as const, {
          description: "Search backend. auto = DuckDuckGo first, Tavily backup.",
          default: "auto",
        }),
      ),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const cap = Math.max(1, Math.min(params.max_results ?? 6, 20));
      const engine = params.engine ?? "auto";
      const tavilyKey = resolveTavilyKey();
      const errors: string[] = [];
      let results: SearchResult[] = [];

      if (engine === "auto" || engine === "duckduckgo") {
        try {
          results = await duckDuckGoSearch(params.query, cap);
        } catch (err) {
          errors.push(`duckduckgo: ${serializeError(err)}`);
        }
      }

      if (results.length === 0 && (engine === "auto" || engine === "tavily")) {
        if (tavilyKey) {
          try {
            results = await tavilySearch(params.query, cap, tavilyKey);
          } catch (err) {
            errors.push(`tavily: ${serializeError(err)}`);
          }
        } else if (engine === "tavily") {
          throw new Error("engine=tavily requested but TAVILY_API_KEY is not set. Export TAVILY_API_KEY or use engine=auto.");
        }
      }

      if (results.length === 0) {
        const detail = errors.length > 0 ? ` (${errors.join("; ")})` : "";
        return {
          content: [{ type: "text", text: `No results for: ${params.query}${detail}` }],
          details: {},
        };
      }

      const used = results[0].source;
      const note = engine === "auto" && used === "tavily" ? " (duckduckgo failed or empty, used tavily backup)" : "";
      const header = `${results.length} results for "${params.query}" via ${used}${note}`;
      return {
        content: [{ type: "text", text: `${header}\n\n${formatResults(results)}` }],
        details: { query: params.query, engine: used, results },
      };
    },
  });
}
