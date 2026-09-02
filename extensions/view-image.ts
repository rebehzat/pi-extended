import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expandHome, fetchWithTimeout, serializeError } from "./lib.ts";

const MAX_BYTES = 15 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

function sniffMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif";
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return undefined;
}

function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 10) return undefined;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function bmpSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 26) return undefined;
  return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "view_image",
    label: "View Image",
    description:
      "Load a local image file or image URL and attach it to the conversation so a vision-capable model can see it. " +
      "Supports png, jpeg, gif, webp, bmp up to 15MB. Use for screenshots, charts, diagrams, photos, or images found via web_run image_search.",
    promptSnippet: "Attach a local image file or image URL to the conversation for visual inspection",
    promptGuidelines: [
      "Use view_image when the user references an image file, screenshot, or image URL, or after web_run image_search returns image URLs you need to inspect.",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Path to a local image file (~ supported)" })),
      url: Type.Optional(Type.String({ description: "URL of a remote image (http/https)" })),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      let data: Buffer;
      let display: string;
      let mimeHint: string | undefined;

      if (params.path && params.url) {
        throw new Error("Provide either `path` or `url`, not both.");
      }

      if (params.path) {
        const file = expandHome(params.path);
        let stat;
        try {
          stat = await (await import("node:fs/promises")).stat(file);
        } catch (err) {
          throw new Error(`Failed to read ${file}: ${serializeError(err)}`);
        }
        if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
        if (stat.size > MAX_BYTES) {
          throw new Error(`Image too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 15MB).`);
        }
        data = await (await import("node:fs/promises")).readFile(file);
        display = file;
        mimeHint = MIME_BY_EXT[file.slice(file.lastIndexOf(".")).toLowerCase()];
      } else if (params.url) {
        if (!/^https?:\/\//i.test(params.url)) {
          throw new Error("url must start with http:// or https://");
        }
        try {
          const res = await fetchWithTimeout(params.url, { timeoutMs: 25000 });
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${params.url}`);
          const ct = res.headers.get("content-type")?.split(";")[0].trim();
          if (ct?.startsWith("image/")) mimeHint = ct === "image/jpg" ? "image/jpeg" : ct;
          const arrayBuf = await res.arrayBuffer();
          if (arrayBuf.byteLength > MAX_BYTES) {
            throw new Error(`Image too large: ${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)}MB (max 15MB).`);
          }
          data = Buffer.from(arrayBuf);
          display = params.url;
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("HTTP ")) throw err;
          if (err instanceof Error && err.message.startsWith("Image too large")) throw err;
          throw new Error(`Failed to fetch ${params.url}: ${serializeError(err)}`);
        }
      } else {
        throw new Error("Provide `path` or `url`.");
      }

      const mime = sniffMime(data) ?? mimeHint;
      if (!mime || !mime.startsWith("image/")) {
        const head = data.subarray(0, 4).toString("hex");
        throw new Error(`Not a recognized image (magic bytes ${head}). Supported: png, jpeg, gif, webp, bmp.`);
      }

      let dims = "";
      if (mime === "image/png") {
        const s = pngSize(data);
        if (s) dims = `, ${s.width}x${s.height}`;
      } else if (mime === "image/gif") {
        const s = gifSize(data);
        if (s) dims = `, ${s.width}x${s.height}`;
      } else if (mime === "image/bmp") {
        const s = bmpSize(data);
        if (s) dims = `, ${s.width}x${s.height}`;
      }

      return {
        content: [
          { type: "image", data: data.toString("base64"), mimeType: mime },
          { type: "text", text: `Loaded ${display} (${mime}${dims}, ${(data.length / 1024).toFixed(0)}KB). The image is attached above.` },
        ],
        details: { source: display, mime, bytes: data.length },
      };
    },
  });
}
