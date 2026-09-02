import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decodeEntities, fetchWithTimeout, serializeError, stripTags, truncate } from "./lib.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

type Engine = "duckduckgo" | "bing" | "brave" | "mojeek" | "searxng" | "tavily";

const AUTO_ORDER: Engine[] = ["duckduckgo", "bing", "brave", "mojeek", "searxng"];

function cleanText(s: string): string {
  return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
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
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    results.push({
      title: cleanText(linkMatch[2]),
      url,
      snippet: snippetMatch ? cleanText(snippetMatch[1]) : "",
      source: "duckduckgo",
    });
  }
  return results;
}

function parseDdgLite(html: string, cap: number): SearchResult[] {
  const results: SearchResult[] = [];
  const rows = html.split(/class="result-link"/i).slice(1);
  for (const row of rows) {
    if (results.length >= cap) break;
    const linkMatch = row.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = decodeDdgHref(linkMatch[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const snippetMatch = row.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i);
    results.push({
      title: cleanText(linkMatch[2]),
      url,
      snippet: snippetMatch ? cleanText(snippetMatch[1]) : "",
      source: "duckduckgo",
    });
  }
  return results;
}

function decodeBingRedirect(href: string): string {
  const raw = decodeEntities(href);
  const u = raw.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
  if (u) {
    try {
      const decoded = Buffer.from(u[1], "base64url").toString("utf8");
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      /* fall through */
    }
  }
  return /^https?:\/\//i.test(raw) && !/bing\.com\/ck/i.test(raw) ? raw : "";
}

function parseBing(html: string, cap: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<li class="b_algo"/i).slice(1);
  for (const block of blocks) {
    if (results.length >= cap) break;
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = decodeBingRedirect(linkMatch[1]);
    if (!url) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({
      title: cleanText(linkMatch[2]),
      url,
      snippet: snippetMatch ? cleanText(snippetMatch[1]) : "",
      source: "bing",
    });
  }
  return results;
}

function parseBrave(html: string, cap: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]*class="[^"]*\bl1\b[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < cap) {
    const url = decodeEntities(m[1]);
    if (url.includes("search.brave.com/") || url.includes("brave.com/images?")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 2000);
    const snip = tail.match(/class="snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    results.push({
      title: cleanText(m[2]) || url,
      url,
      snippet: snip ? cleanText(snip[1]).slice(0, 300) : "",
      source: "brave",
    });
  }
  return results;
}

function parseMojeek(html: string, cap: number): SearchResult[] {
  const results: SearchResult[] = [];
  const re = /<a[^>]*class="ob"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < cap) {
    const url = decodeEntities(m[1]);
    const tail = html.slice(m.index, m.index + 3000);
    const snip = tail.match(/<p class="s">([\s\S]*?)<\/p>/i);
    results.push({ title: cleanText(m[2]) || url, url, snippet: snip ? cleanText(snip[1]) : "", source: "mojeek" });
  }
  return results;
}

const SEARX_INSTANCES = ["https://searx.be", "https://searx.tiekoetter.com", "https://search.inetol.net", "https://paulgo.io"];

async function searxSearch(query: string, cap: number): Promise<SearchResult[]> {
  for (const base of SEARX_INSTANCES) {
    try {
      const res = await fetchWithTimeout(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
        timeoutMs: 8000,
        headers: { accept: "application/json" },
      });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) continue;
      const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
      const results = (data.results ?? [])
        .filter((r) => r.url && /^https?:\/\//i.test(r.url))
        .slice(0, cap)
        .map((r) => ({ title: r.title ?? r.url!, url: r.url!, snippet: (r.content ?? "").trim(), source: "searxng" }));
      if (results.length > 0) return results;
    } catch {
      continue;
    }
  }
  return [];
}

export async function duckDuckGoSearch(query: string, cap: number): Promise<SearchResult[]> {
  for (const endpoint of ["https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"]) {
    try {
      const res = await fetchWithTimeout(endpoint, {
        method: endpoint.includes("html") ? "POST" : "GET",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
        },
        ...(endpoint.includes("html") ? { body: new URLSearchParams({ q: query }).toString() } : { body: undefined }),
        timeoutMs: 15000,
      });
      if (!res.ok) continue;
      const html = await res.text();
      if (/anomaly|challenge|captcha/i.test(html) && !/result__a/i.test(html)) continue;
      const results = endpoint.includes("html") ? parseDdgHtml(html, cap) : parseDdgLite(html, cap);
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
      source: "tavily",
    }));
}

async function runEngine(engine: Engine, query: string, cap: number, tavilyKey?: string): Promise<SearchResult[]> {
  switch (engine) {
    case "duckduckgo":
      return duckDuckGoSearch(query, cap);
    case "bing":
      return parseBing(
        await (
          await fetchWithTimeout(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.max(cap, 10)}`, {
            timeoutMs: 15000,
            headers: { "accept-language": "en-US,en;q=0.9" },
          })
        ).text(),
        cap,
      );
    case "brave":
      return parseBrave(
        await (
          await fetchWithTimeout(`https://search.brave.com/search?q=${encodeURIComponent(query)}`, { timeoutMs: 15000 })
        ).text(),
        cap,
      );
    case "mojeek":
      return parseMojeek(
        await (
          await fetchWithTimeout(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, { timeoutMs: 15000 })
        ).text(),
        cap,
      );
    case "searxng":
      return searxSearch(query, cap);
    case "tavily":
      return tavilyKey ? tavilySearch(query, cap, tavilyKey) : [];
  }
}

export interface SearchOutcome {
  results: SearchResult[];
  engine?: string;
  errors: string[];
}

export async function searchWeb(query: string, cap: number, engine: Engine | "auto" = "auto"): Promise<SearchOutcome> {
  const tavilyKey = resolveTavilyKey();
  const errors: string[] = [];
  const order: Engine[] = engine === "auto" ? AUTO_ORDER : [engine];

  for (const e of order) {
    try {
      const results = await runEngine(e, query, cap, tavilyKey);
      if (results.length > 0) return { results, engine: e, errors };
      errors.push(`${e}: 0 results`);
    } catch (err) {
      errors.push(`${e}: ${serializeError(err)}`);
    }
  }

  if ((engine === "auto" || engine === "tavily") && tavilyKey) {
    try {
      const results = await tavilySearch(query, cap, tavilyKey);
      if (results.length > 0) return { results, engine: "tavily", errors };
      errors.push("tavily: 0 results");
    } catch (err) {
      errors.push(`tavily: ${serializeError(err)}`);
    }
  }

  return { results: [], errors };
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
      "Web search returning a list of {title, url, snippet}. Tries multiple engines in order (DuckDuckGo, Bing, Brave, Mojeek, " +
      "SearXNG instances) and falls back to the Tavily API when TAVILY_API_KEY is set. The first engine with results wins; " +
      "set engine to force a specific backend.",
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
        StringEnum(["auto", "duckduckgo", "bing", "brave", "mojeek", "searxng", "tavily"] as const, {
          description: "Search backend. auto = try all in order until results are found.",
          default: "auto",
        }),
      ),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const cap = Math.max(1, Math.min(params.max_results ?? 6, 20));
      const { results, engine, errors } = await searchWeb(params.query, cap, params.engine ?? "auto");

      if (engine === "tavily" && !resolveTavilyKey()) {
        throw new Error("engine=tavily requested but TAVILY_API_KEY is not set.");
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No results for: ${params.query}${errors.length > 0 ? ` (tried: ${errors.join("; ")})` : ""}`,
            },
          ],
          details: { query: params.query, errors },
        };
      }

      const note = params.engine === undefined || params.engine === "auto" ? ` (first engine with results)` : "";
      return {
        content: [{ type: "text", text: `${results.length} results for "${params.query}" via ${engine}${note}:\n\n${formatResults(results)}` }],
        details: { query: params.query, engine, results },
      };
    },
  });
}
