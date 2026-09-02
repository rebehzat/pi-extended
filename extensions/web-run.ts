import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  expandHome,
  extractLinks,
  extractTitle,
  fetchWithTimeout,
  htmlToText,
  nowIso,
  serializeError,
  tmpDirFor,
  truncate,
  which,
} from "./lib.ts";
import { duckDuckGoSearch, formatResults, resolveTavilyKey, tavilySearch, type SearchResult } from "./web-search.ts";

interface Page {
  id: number;
  url: string;
  title: string;
  text: string;
  links: { url: string; text: string }[];
}

const MAX_PAGES = 12;
const OPEN_TEXT_CHARS = 6000;
const pages = new Map<number, Page>();
let nextPageId = 1;

type WebContent = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

interface WebOutput {
  content: WebContent;
  details?: Record<string, unknown>;
}

function textOut(text: string, details?: Record<string, unknown>): WebOutput {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

function storePage(url: string, html: string): Page {
  if (pages.size >= MAX_PAGES) {
    const oldest = Math.min(...pages.keys());
    pages.delete(oldest);
  }
  const page: Page = {
    id: nextPageId++,
    url,
    title: extractTitle(html),
    text: htmlToText(html),
    links: extractLinks(html, url),
  };
  pages.set(page.id, page);
  return page;
}

function formatPage(page: Page): string {
  const lines = [
    `Page #${page.id}: ${page.title || "(no title)"}`,
    `URL: ${page.url}`,
    "",
    truncate(page.text, OPEN_TEXT_CHARS),
  ];
  if (page.links.length > 0) {
    lines.push("", "Links (use web_run click with page_id + link_number):");
    page.links.slice(0, 25).forEach((l, i) => lines.push(`  ${i + 1}. ${truncate(l.text, 80)} -> ${l.url}`));
    if (page.links.length > 25) lines.push(`  ... ${page.links.length - 25} more links`);
  }
  return lines.join("\n");
}

function isProbablyPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

async function doOpen(rawUrl: string, signal?: AbortSignal): Promise<WebOutput> {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (isProbablyPdfUrl(url)) return handlePdf({ url }, signal);

  const res = await fetchWithTimeout(url, { timeoutMs: 25000, signal, redirect: "follow" });
  if (!res.ok) {
    return textOut(`HTTP ${res.status} ${res.statusText} fetching ${url}`, { url, status: res.status });
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/pdf") || isProbablyPdfUrl(res.url || url)) {
    return handlePdf({ url: res.url || url }, signal);
  }
  const html = await res.text();
  const page = storePage(res.url || url, html);
  if (page.text.length === 0 && page.links.length === 0) {
    return textOut(`Loaded ${url} but it appears to be empty or non-HTML (content-type: ${contentType}).`, { page_id: page.id });
  }
  return textOut(formatPage(page), { page_id: page.id, url: page.url, title: page.title });
}

async function doFind(pageId: number, pattern: string): Promise<WebOutput> {
  const page = pages.get(pageId);
  if (!page) throw new Error(`Unknown page_id ${pageId}. Open a page first with web_run open.`);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const lines = page.text.split("\n");
  const hits: string[] = [];
  for (let i = 0; i < lines.length && hits.length < 50; i++) {
    if (regex.test(lines[i])) hits.push(`L${i + 1}: ${lines[i].trim()}`);
  }
  if (hits.length === 0) return textOut(`No matches for /${pattern}/ in page #${pageId} (${page.url}).`);
  return textOut(
    `Found ${hits.length}${hits.length >= 50 ? "+" : ""} matches for /${pattern}/ in page #${pageId}:\n${hits.join("\n")}`,
  );
}

async function doImageSearch(
  query: string,
  downloadIndex: number | undefined,
  signal?: AbortSignal,
): Promise<WebOutput> {
  const images: { title: string; image_url: string; source: string; width?: number; height?: number }[] = [];
  const errors: string[] = [];

  const tavilyKey = resolveTavilyKey();
  if (tavilyKey) {
    try {
      const res = await fetchWithTimeout("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: tavilyKey, query, max_results: 10, include_images: true, search_depth: "basic" }),
        timeoutMs: 20000,
        signal,
      });
      if (res.ok) {
        const data = (await res.json()) as { images?: Array<string | { url?: string }> };
        for (const img of data.images ?? []) {
          const u = typeof img === "string" ? img : img.url;
          if (u) images.push({ title: query, image_url: u, source: "tavily" });
        }
      } else {
        errors.push(`tavily HTTP ${res.status}`);
      }
    } catch (err) {
      errors.push(`tavily: ${serializeError(err)}`);
    }
  }

  if (images.length === 0) {
    try {
      const tokenRes = await fetchWithTimeout(
        `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
        { timeoutMs: 15000, signal },
      );
      const tokenHtml = await tokenRes.text();
      const vqd = tokenHtml.match(/vqd=["']?([\d-]+)["']?/)?.[1];
      if (vqd) {
        const res = await fetchWithTimeout(
          `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1`,
          { timeoutMs: 15000, signal, headers: { referer: "https://duckduckgo.com/" } },
        );
        if (res.ok) {
          const data = (await res.json()) as {
            results?: Array<{ image: string; title?: string; url?: string; width?: number; height?: number }>;
          };
          for (const r of data.results ?? []) {
            images.push({ title: r.title ?? query, image_url: r.image, source: r.url ?? "ddg", width: r.width, height: r.height });
          }
        } else {
          errors.push(`ddg i.js HTTP ${res.status}`);
        }
      } else {
        errors.push("ddg vqd token not found");
      }
    } catch (err) {
      errors.push(`ddg: ${serializeError(err)}`);
    }
  }

  if (images.length === 0) {
    return textOut(
      `No image results for "${query}"${errors.length ? ` (${errors.join("; ")})` : ""}. Set TAVILY_API_KEY for better coverage.`,
    );
  }

  const listed = images.slice(0, 10);
  const listing = listed
    .map((img, i) => {
      const dims = img.width && img.height ? ` (${img.width}x${img.height})` : "";
      return `${i + 1}. ${truncate(img.title, 70)}${dims}\n   ${img.image_url}`;
    })
    .join("\n");

  const content: WebContent = [
    {
      type: "text",
      text: `${images.length} image results for "${query}". Use view_image with an image_url, or web_run image_search download_index to inline one.\n\n${listing}`,
    },
  ];

  if (downloadIndex !== undefined && downloadIndex >= 1 && downloadIndex <= listed.length) {
    const target = listed[downloadIndex - 1];
    try {
      const res = await fetchWithTimeout(target.image_url, { timeoutMs: 20000, signal });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
        if (buf.length <= 10 * 1024 * 1024 && mime.startsWith("image/")) {
          content.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
          const first = content[0];
          if (first.type === "text") first.text = `${first.text}\n\n[Attached image #${downloadIndex} inline]`;
        }
      }
    } catch {
      /* keep listing only */
    }
  }

  return { content, details: { count: images.length } };
}

const SPORT_PATHS: Record<string, string> = {
  nba: "basketball/nba",
  wnba: "basketball/wnba",
  ncaab: "basketball/mens-college-basketball",
  nfl: "football/nfl",
  ncaaf: "football/college-football",
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
  epl: "soccer/eng.1",
  laliga: "soccer/esp.1",
  seriea: "soccer/ita.1",
  bundesliga: "soccer/ger.1",
  ligue1: "soccer/fra.1",
  ucl: "soccer/uefa.champions",
  mls: "soccer/usa.1",
  f1: "racing/f1",
  atp: "tennis/atp",
  wta: "tennis/wta",
};

function espnPath(sport?: string, path?: string): string | undefined {
  if (path) return path;
  if (sport) return SPORT_PATHS[sport.toLowerCase()] ?? undefined;
  return undefined;
}

async function espnScoreboard(path: string, date?: string, team?: string, signal?: AbortSignal): Promise<string> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard${date ? `?dates=${date}` : ""}`;
  const res = await fetchWithTimeout(url, { timeoutMs: 15000, signal });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status} for ${path}`);
  const data = (await res.json()) as {
    events?: Array<{
      name?: string;
      shortName?: string;
      date?: string;
      status?: { type?: { shortDetail?: string } };
      competitions?: Array<{
        competitors?: Array<{
          homeAway?: string;
          score?: string;
          team?: { displayName?: string; abbreviation?: string };
        }>;
      }>;
    }>;
  };
  const events = data.events ?? [];
  if (events.length === 0) return `No games found for ${path}${date ? ` on ${date}` : ""}.`;
  const lines: string[] = [];
  for (const ev of events) {
    const comp = ev.competitions?.[0];
    const competitors = comp?.competitors ?? [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    const label = ev.name ?? ev.shortName ?? "(game)";
    const status = ev.status?.type?.shortDetail ?? "";
    if (team) {
      const t = team.toLowerCase();
      const inGame = competitors.some(
        (c) => c.team?.displayName?.toLowerCase().includes(t) || c.team?.abbreviation?.toLowerCase() === t,
      );
      if (!inGame) continue;
    }
    const score =
      home && away
        ? `${away.team?.abbreviation ?? "?"} ${away.score ?? "-"} @ ${home.team?.abbreviation ?? "?"} ${home.score ?? "-"}`
        : "";
    lines.push(`- ${label} | ${status}${score ? ` | ${score}` : ""}${ev.date ? ` | ${ev.date}` : ""}`);
    if (lines.length >= 20) break;
  }
  if (lines.length === 0) return `No games matching team "${team}" for ${path}${date ? ` on ${date}` : ""}.`;
  return `Scoreboard for ${path}${date ? ` on ${date}` : ""}:\n${lines.join("\n")}`;
}

async function espnStandings(path: string, signal?: AbortSignal): Promise<string> {
  const res = await fetchWithTimeout(`https://site.api.espn.com/apis/v2/sports/${path}/standings`, {
    timeoutMs: 15000,
    signal,
  });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status} for ${path} standings`);
  const data = (await res.json()) as {
    children?: Array<{
      name?: string;
      standings?: {
        entries?: Array<{
          team?: { displayName?: string };
          stats?: Array<{ name?: string; displayValue?: string }>;
        }>;
      };
    }>;
  };
  const children = data.children ?? [];
  if (children.length === 0) return `No standings found for ${path}.`;
  const out: string[] = [];
  for (const child of children.slice(0, 6)) {
    out.push(`\n${child.name ?? "Standings"}:`);
    const entries = child.standings?.entries ?? [];
    for (const entry of entries.slice(0, 20)) {
      const get = (n: string) => entry.stats?.find((s) => s.name === n)?.displayValue ?? "";
      const rank = get("rank");
      const teamName = entry.team?.displayName ?? "?";
      out.push(
        `  ${rank ? `${rank}. ` : ""}${teamName} | W:${get("wins")} L:${get("losses")}${get("ties") ? ` T:${get("ties")}` : ""}${get("gamesBack") ? ` GB:${get("gamesBack")}` : ""}${get("pointDifferential") ? ` PD:${get("pointDifferential")}` : ""}`,
      );
    }
  }
  return `Standings for ${path}:\n${out.join("\n")}`;
}

async function doWeather(location: string, signal?: AbortSignal): Promise<string> {
  const url = `https://wttr.in/${encodeURIComponent(location || "auto")}?format=j1`;
  const res = await fetchWithTimeout(url, { timeoutMs: 15000, signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`wttr.in HTTP ${res.status} for "${location}"`);
  const data = (await res.json()) as {
    current_condition?: Array<{
      temp_C?: string;
      FeelsLikeC?: string;
      humidity?: string;
      weatherDesc?: Array<{ value?: string }>;
      windspeedKmph?: string;
      winddir16Point?: string;
      precipMM?: string;
      cloudcover?: string;
      pressure?: string;
      visibility?: string;
    }>;
    weather?: Array<{
      date?: string;
      mintempC?: string;
      maxtempC?: string;
      astronomy?: Array<{ sunrise?: string; sunset?: string }>;
      hourly?: Array<{ time?: string; weatherDesc?: Array<{ value?: string }> }>;
    }>;
    nearest_area?: Array<{ areaName?: Array<{ value?: string }>; country?: Array<{ value?: string }> }>;
  };
  const cur = data.current_condition?.[0];
  if (!cur) throw new Error(`No weather data for "${location}".`);
  const area = data.nearest_area?.[0];
  const lines = [
    `Weather for ${area?.areaName?.[0]?.value ?? location}${area?.country?.[0]?.value ? `, ${area.country[0].value}` : ""}`,
    `Now: ${cur.temp_C}C (feels ${cur.FeelsLikeC}C), ${cur.weatherDesc?.[0]?.value ?? ""}, humidity ${cur.humidity}%, wind ${cur.winddir16Point ?? ""} ${cur.windspeedKmph ?? ""}km/h, precip ${cur.precipMM}mm, clouds ${cur.cloudcover}%, pressure ${cur.pressure}hPa, visibility ${cur.visibility}km`,
  ];
  for (const day of (data.weather ?? []).slice(0, 3)) {
    const noon = day.hourly?.find((h) => h.time === "1200") ?? day.hourly?.[4];
    const astro = day.astronomy?.[0];
    lines.push(
      `${day.date}: min ${day.mintempC}C / max ${day.maxtempC}C, ${noon?.weatherDesc?.[0]?.value ?? ""}${astro?.sunrise && astro?.sunset ? `, sunrise ${astro.sunrise} sunset ${astro.sunset}` : ""}`,
    );
  }
  return lines.join("\n");
}

async function doFinance(symbols: string[], signal?: AbortSignal): Promise<string> {
  const out: string[] = [];
  for (const symbol of symbols.slice(0, 8)) {
    const clean = symbol.trim().toUpperCase();
    if (!clean) continue;
    for (const host of ["query1", "query2"]) {
      try {
        const res = await fetchWithTimeout(
          `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean)}?range=5d&interval=1d`,
          { timeoutMs: 15000, signal, headers: { accept: "application/json" } },
        );
        if (!res.ok) {
          if (host === "query2") out.push(`${clean}: Yahoo HTTP ${res.status}`);
          continue;
        }
        const data = (await res.json()) as {
          chart?: {
            result?: Array<{
              meta?: {
                regularMarketPrice?: number;
                chartPreviousClose?: number;
                previousClose?: number;
                currency?: string;
                exchangeName?: string;
                longName?: string;
                regularMarketDayHigh?: number;
                regularMarketDayLow?: number;
                regularMarketVolume?: number;
                fiftyTwoWeekHigh?: number;
                fiftyTwoWeekLow?: number;
              };
            }>;
          };
        };
        const meta = data.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) {
          out.push(`${clean}: no quote data`);
          break;
        }
        const prev = meta.chartPreviousClose ?? meta.previousClose;
        const change = prev ? meta.regularMarketPrice - prev : undefined;
        const pct = prev && change !== undefined ? (change / prev) * 100 : undefined;
        out.push(
          [
            `${clean}${meta.longName ? ` (${meta.longName})` : ""} [${meta.exchangeName ?? ""}]`,
            `  ${meta.regularMarketPrice} ${meta.currency ?? ""} ${change !== undefined ? `| chg ${change >= 0 ? "+" : ""}${change.toFixed(2)}${pct !== undefined ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : ""}` : ""}`,
            [
              meta.regularMarketDayLow !== undefined ? `day L/H ${meta.regularMarketDayLow}/${meta.regularMarketDayHigh}` : "",
              meta.fiftyTwoWeekLow !== undefined ? `52w L/H ${meta.fiftyTwoWeekLow}/${meta.fiftyTwoWeekHigh}` : "",
              meta.regularMarketVolume !== undefined ? `vol ${meta.regularMarketVolume.toLocaleString()}` : "",
            ]
              .filter(Boolean)
              .join(" | "),
          ].join("\n"),
        );
        break;
      } catch (err) {
        if (host === "query2") out.push(`${clean}: ${serializeError(err)}`);
      }
    }
  }
  return out.length > 0 ? out.join("\n\n") : "No symbols provided.";
}

function formatTimeZone(zone: string): string {
  const now = new Date();
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "shortOffset",
    });
    const parts = fmt.formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${zone}: ${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
  } catch {
    return `${zone}: unknown timezone`;
  }
}

async function handlePdf(
  params: { url?: string; pdf_path?: string; pages?: string },
  signal?: AbortSignal,
): Promise<WebOutput> {
  let file = "";
  let cleanup: (() => Promise<void>) | undefined;

  if (params.pdf_path) {
    file = expandHome(params.pdf_path);
  } else if (params.url) {
    const dir = await tmpDirFor("webrun-pdf-");
    file = `${dir}/doc.pdf`;
    const res = await fetchWithTimeout(params.url, { timeoutMs: 45000, signal });
    if (!res.ok) return textOut(`HTTP ${res.status} downloading PDF ${params.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 50 * 1024 * 1024) return textOut("PDF too large (>50MB).");
    await (await import("node:fs/promises")).writeFile(file, buf);
    cleanup = async () => {
      try {
        await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };
  } else {
    return textOut("Provide `url` or `pdf_path` for PDF handling.");
  }

  try {
    const hasPdftoppm = await which("pdftoppm");
    const hasPdftotext = await which("pdftotext");
    if (!hasPdftoppm && !hasPdftotext) {
      return textOut("PDF support requires poppler-utils (pdftoppm/pdftotext). Install with: sudo apt install poppler-utils");
    }

    const { execFile } = await import("node:child_process");
    const run = (cmd: string, args: string[]) =>
      new Promise<{ stdout: string; code: number }>((resolve) => {
        execFile(cmd, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
          resolve({ stdout, code: err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0 });
        });
      });

    const info = await run("pdfinfo", [file]);
    const pageCount = Number.parseInt(info.stdout.match(/Pages:\s+(\d+)/)?.[1] ?? "0", 10);

    let text = "";
    if (hasPdftotext) {
      const txt = await run("pdftotext", ["-l", "20", file, "-"]);
      text = truncate(txt.stdout.replace(/\n{3,}/g, "\n\n").trim(), 4000);
    }

    const pagesSpec = params.pages ?? "1-2";
    const parts = pagesSpec.split("-").map((n) => Number.parseInt(n, 10));
    const start = Math.max(1, parts[0] || 1);
    const end = Math.min(Math.max(start, parts[1] || start), start + 3, pageCount || start);
    const images: string[] = [];

    if (hasPdftoppm) {
      const dir = await tmpDirFor("webrun-pdfimg-");
      const prefix = `${dir}/page`;
      const render = await run("pdftoppm", ["-png", "-r", "110", "-f", String(start), "-l", String(end), file, prefix]);
      if (render.code === 0) {
        const fsMod = await import("node:fs/promises");
        const files = (await fsMod.readdir(dir)).filter((f) => f.startsWith("page") && f.endsWith(".png")).sort();
        for (const f of files) {
          const buf = await fsMod.readFile(`${dir}/${f}`);
          if (buf.length <= 10 * 1024 * 1024) images.push(buf.toString("base64"));
          else break;
        }
        void fsMod.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }

    const content: WebContent = [];
    let header = `PDF: ${params.url ?? params.pdf_path}${pageCount ? ` (${pageCount} pages)` : ""}, rendered pages ${start}-${end}`;
    if (!hasPdftoppm) header += " (pdftoppm missing, text only - install poppler-utils for page images)";
    content.push({
      type: "text",
      text: `${header}\n\n--- text (first ~20 pages, truncated) ---\n${text || "(no text layer)"}`,
    });
    for (const img of images.slice(0, 3)) {
      content.push({ type: "image", data: img, mimeType: "image/png" });
    }
    return { content, details: { pdf_pages: pageCount } };
  } finally {
    if (cleanup) await cleanup();
  }
}

const WebRunParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("search"),
      Type.Literal("open"),
      Type.Literal("click"),
      Type.Literal("find"),
      Type.Literal("image_search"),
      Type.Literal("weather"),
      Type.Literal("finance"),
      Type.Literal("sports"),
      Type.Literal("time"),
      Type.Literal("pdf"),
    ],
    { description: "What to do" },
  ),
  query: Type.Optional(Type.String({ description: "Search/image_search query" })),
  url: Type.Optional(Type.String({ description: "open/pdf: URL to fetch" })),
  pdf_path: Type.Optional(Type.String({ description: "pdf: local PDF file path" })),
  page_id: Type.Optional(Type.Number({ description: "click/find: page id returned by open" })),
  link_number: Type.Optional(Type.Number({ description: "click: link number from the page listing" })),
  pattern: Type.Optional(Type.String({ description: "find: text or regex to search within the page" })),
  download_index: Type.Optional(Type.Number({ description: "image_search: 1-based index of an image result to attach inline" })),
  location: Type.Optional(Type.String({ description: "weather: city or place (default: auto by IP)" })),
  symbols: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], { description: 'finance: symbol or list, e.g. "AAPL" or ["AAPL","BTC-USD"]' }),
  ),
  sport: Type.Optional(Type.String({ description: `sports: preset league (${Object.keys(SPORT_PATHS).join(", ")})` })),
  espn_path: Type.Optional(Type.String({ description: "sports: raw ESPN path escape hatch, e.g. soccer/eng.1" })),
  mode: Type.Optional(
    Type.Union([Type.Literal("scoreboard"), Type.Literal("standings")], { description: "sports: default scoreboard", default: "scoreboard" }),
  ),
  date: Type.Optional(Type.String({ description: "sports: date as YYYYMMDD (default today)" })),
  team: Type.Optional(Type.String({ description: "sports: filter scoreboard to a team name/abbreviation" })),
  timezone: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], { description: 'time: IANA timezone or list, e.g. "America/New_York". Default: local.' }),
  ),
  pages: Type.Optional(Type.String({ description: 'pdf: page range like "1-3" (default "1-2")' })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_run",
    label: "Web Run",
    description:
      "All-in-one web access tool (aka web.run). Actions: " +
      "search (web results), open (fetch a page as readable text with numbered links), " +
      "click (follow a numbered link by page_id), find (search text/regex within an opened page), " +
      "image_search (find images; optional inline download), pdf (render PDF pages to images + extract text), " +
      "weather (forecast via wttr.in), finance (stock/crypto quotes via Yahoo), " +
      "sports (scoreboards and standings via ESPN), time (current time per timezone).",
    promptSnippet: "Web access: search, open/click/find pages, PDF rendering, image search, weather, finance, sports, time",
    promptGuidelines: [
      "Use web_run open to read a page, then web_run click/find to navigate within it; use web_run search for discovery.",
      "Use web_run for weather, finance quotes, sports schedules/standings, current time, image search, and PDF viewing instead of guessing.",
    ],
    parameters: WebRunParams,

    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      let out: WebOutput;
      switch (params.action) {
        case "search": {
          if (!params.query) throw new Error("search requires `query`.");
          const cap = 8;
          let results: SearchResult[] = await duckDuckGoSearch(params.query, cap).catch(() => []);
          if (results.length === 0) {
            const key = resolveTavilyKey();
            if (key) results = await tavilySearch(params.query, cap, key).catch(() => []);
          }
          if (results.length === 0) out = textOut(`No results for "${params.query}".`);
          else out = textOut(`Search results for "${params.query}":\n\n${formatResults(results)}`, { query: params.query, count: results.length });
          break;
        }

        case "open": {
          if (!params.url) throw new Error("open requires `url`.");
          out = await doOpen(params.url, signal);
          break;
        }

        case "click": {
          if (params.page_id === undefined || !params.link_number) {
            throw new Error("click requires `page_id` and `link_number`.");
          }
          const page = pages.get(params.page_id);
          if (!page) throw new Error(`Unknown page_id ${params.page_id}.`);
          const link = page.links[params.link_number - 1];
          if (!link) {
            throw new Error(`Page #${page.id} has ${page.links.length} links; no link #${params.link_number}.`);
          }
          out = await doOpen(link.url, signal);
          const first = out.content[0];
          if (first.type === "text") {
            first.text = `Clicked link #${params.link_number} (${link.text}) from page #${page.id}:\n\n${first.text}`;
          }
          break;
        }

        case "find": {
          if (params.page_id === undefined || !params.pattern) {
            throw new Error("find requires `page_id` and `pattern`.");
          }
          out = await doFind(params.page_id, params.pattern);
          break;
        }

        case "image_search": {
          if (!params.query) throw new Error("image_search requires `query`.");
          out = await doImageSearch(params.query, params.download_index, signal);
          break;
        }

        case "weather": {
          out = textOut(await doWeather(params.location ?? "", signal));
          break;
        }

        case "finance": {
          const symbols = typeof params.symbols === "string" ? params.symbols.split(",") : (params.symbols ?? []);
          if (symbols.length === 0) throw new Error("finance requires `symbols`.");
          out = textOut(await doFinance(symbols, signal));
          break;
        }

        case "sports": {
          const path = espnPath(params.sport, params.espn_path);
          if (!path) {
            throw new Error(`Unknown sport. Presets: ${Object.keys(SPORT_PATHS).join(", ")}, or pass espn_path.`);
          }
          const text =
            params.mode === "standings"
              ? await espnStandings(path, signal)
              : await espnScoreboard(path, params.date, params.team, signal);
          out = textOut(text);
          break;
        }

        case "time": {
          const zones = typeof params.timezone === "string" ? params.timezone.split(",") : (params.timezone ?? []);
          const list = zones.length > 0 ? zones.map((z) => z.trim()) : [Intl.DateTimeFormat().resolvedOptions().timeZone];
          const text = [...list.map(formatTimeZone), `Unix epoch (ms): ${Date.now()}`, `ISO: ${nowIso()}`].join("\n");
          out = textOut(text);
          break;
        }

        case "pdf": {
          out = await handlePdf({ url: params.url, pdf_path: params.pdf_path, pages: params.pages }, signal);
          break;
        }
      }
      return { content: out.content, details: out.details ?? {} };
    },
  });
}
