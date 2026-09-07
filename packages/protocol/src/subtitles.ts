import type { TitleOverlay } from "./timeline";

export type SubtitleFormat = "srt" | "vtt";
export interface SubtitleCue { text: string; startUs: number; durationUs: number }
export interface ParsedSubtitles { cues: SubtitleCue[]; warnings: string[] }

const maxBytes = 2 * 1024 * 1024;
function timestamp(value: string, format: SubtitleFormat): number {
  const match = (format === "srt" ? /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/ : /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/).exec(value);
  if (!match) throw new Error(`Invalid ${format.toUpperCase()} timestamp: ${value}`);
  const time = ((Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(match[4])) * 1000;
  if (!Number.isSafeInteger(time)) throw new Error("Subtitle time is too large");
  return time;
}

function plainText(value: string, warnings: Set<string>): string {
  const withoutTags = value.replace(/<\/?(?:b|i|u|ruby|rt|font|c|v|lang)(?=[\s.>])[^>]*>|<(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}>/gi, () => {
    warnings.add("Inline styling, speaker tags, and karaoke timing were converted to plain text.");
    return "";
  });
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", lrm: "\u200e", rlm: "\u200f" };
  return withoutTags.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi, (entity, key: string) => {
    if (!key.startsWith("#")) return entities[key.toLowerCase()];
    const code = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  }).trim();
}

/** Strict timing and cue validation: a malformed file never produces a partial import. */
export function parseSubtitles(content: string, format: SubtitleFormat, offsetUs = 0): ParsedSubtitles {
  if (!["srt", "vtt"].includes(format)) throw new Error("Choose SRT or WebVTT");
  if (!Number.isSafeInteger(offsetUs)) throw new Error("Subtitle offset must be integer microseconds");
  if (new TextEncoder().encode(content).length > maxBytes || content.includes("\0")) throw new Error("Use a UTF-8 subtitle file of at most 2 MB, without null characters");
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  const blocks = normalized.split(/\n[ \t]*\n+/);
  const warnings = new Set<string>();
  if (format === "vtt") {
    const header = blocks.shift()?.split("\n") ?? [];
    if (!/^WEBVTT(?:[ \t].*)?$/.test(header[0] ?? "") || header.some((line) => line.includes("-->"))) throw new Error("WebVTT needs a WEBVTT header followed by a blank line");
    if (header.length > 1) warnings.add("WebVTT header metadata was omitted.");
  }
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    if (format === "vtt" && /^(?:NOTE(?:[ \t\n]|$)|STYLE(?:\n|$)|REGION(?:\n|$))/.test(block)) {
      if (!block.startsWith("NOTE")) warnings.add("WebVTT stylesheet and region blocks were omitted.");
      continue;
    }
    const lines = block.split("\n");
    let timing = lines.shift() ?? "";
    if (!timing.includes("-->")) timing = lines.shift() ?? ""; // Optional cue identifier.
    const match = /^\s*(\S+)\s+-->\s+(\S+)(?:[ \t]+(.*))?\s*$/.exec(timing);
    if (!match) throw new Error(`Cue ${cues.length + 1}: missing or malformed timing line`);
    const startUs = timestamp(match[1], format) + offsetUs;
    const endUs = timestamp(match[2], format) + offsetUs;
    if (!Number.isSafeInteger(startUs) || !Number.isSafeInteger(endUs) || startUs < 0 || endUs <= startUs) throw new Error(`Cue ${cues.length + 1}: end must follow start, and offset must keep times nonnegative`);
    if (match[3]?.trim()) warnings.add("Cue positioning settings were replaced with the editor's caption style.");
    const text = plainText(lines.join("\n"), warnings);
    if (!text || new TextEncoder().encode(text).length > 4000) throw new Error(`Cue ${cues.length + 1}: text must contain 1–4,000 UTF-8 bytes`);
    cues.push({ text, startUs, durationUs: endUs - startUs });
    if (cues.length > 5000) throw new Error("Import at most 5,000 captions at once");
  }
  if (!cues.length) throw new Error("No subtitle cues were found");
  cues.sort((a, b) => a.startUs - b.startUs);
  return { cues, warnings: [...warnings] };
}

function formattedTime(milliseconds: number, format: SubtitleFormat): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${format === "srt" ? "," : "."}${String(milliseconds % 1000).padStart(3, "0")}`;
}

/** Subtitle interchange carries caption text/timing only; ordinary titles are excluded. */
export function serializeSubtitles(titles: TitleOverlay[], format: SubtitleFormat): { content: string; count: number } {
  if (!["srt", "vtt"].includes(format)) throw new Error("Choose SRT or WebVTT");
  const captions = titles.filter((title) => title.kind === "caption").sort((a, b) => a.startUs - b.startUs);
  const blocks = captions.map((cue, index) => {
    if (!Number.isSafeInteger(cue.startUs) || !Number.isSafeInteger(cue.startUs + cue.durationUs) || cue.startUs < 0 || cue.durationUs <= 0 || !cue.text.trim()) throw new Error("A caption has invalid timing or empty text");
    const start = Math.round(cue.startUs / 1000);
    const end = Math.max(start + 1, Math.round((cue.startUs + cue.durationUs) / 1000));
    const text = cue.text.replace(/\r\n?/g, "\n").trim().split("\n").map((line) => line.trim() ? line : "\u00a0").join("\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `${index + 1}\n${formattedTime(start, format)} --> ${formattedTime(end, format)}\n${text}`;
  });
  const content = (format === "vtt" ? "WEBVTT\n\n" : "") + blocks.join("\n\n") + (blocks.length ? "\n" : "");
  if (new TextEncoder().encode(content).length > maxBytes) throw new Error("Subtitle output exceeds 2 MB");
  return { content, count: captions.length };
}
