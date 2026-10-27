import { invoke } from "./invoke.ts";
import { transcriptionInvokeParams, type TranscriptionProvider } from "./transcription.ts";
import { isTauri } from "./ipc.ts";
import type { CommandOutput, VideoMetadata } from "../types/index.ts";

/** One auto-found clip window (seconds on the source timeline). */
export interface StreamClip {
  start: number;
  end: number;
  /** 0..1 quality score. */
  score: number;
  reason: string;
  text: string;
}

/** Video-card metadata for a pasted link (loads in the background). */
export interface StreamProbe {
  url: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  duration: number;
  view_count: number | null;
  upload_date: string | null;
  is_live: boolean;
}

export interface SuggestStreamClipsOptions {
  transcriptionProvider?: TranscriptionProvider;
  elevenlabsKey?: string;
  agentId?: string;
  channelContext?: string;
  promptHook?: string;
  threshold?: number;
  minLength?: number;
  maxLength?: number;
  maxClips?: number;
  minGap?: number;
  /** Chosen band. The engine receives `minLength` and `maxLength`. */
  length?: StreamLengthId;
}

export interface SuggestStreamClipsResult {
  url: string;
  title: string;
  channel: string;
  duration: number;
  transcriptSource: string;
  wordsCount: number;
  /** `agent:<id>` when the editing model planned the clips, else `heuristic`. */
  picker: string;
  pickerNote: string;
  clips: StreamClip[];
}

export type StreamWorkflow = "automatic" | "review";

/** Clip-finder settings for one search.
 *
 * The caller supplies the editing model, channel context, and the length
 * band chosen before Find clips. An unknown band stays on Standard. */
export function streamSuggestOptions(opts: {
  agentId?: string;
  channelContext?: string;
  promptHook?: string;
  length?: unknown;
}): SuggestStreamClipsOptions {
  const length = parseStreamLength(opts.length);
  const band = STREAM_LENGTHS[length];
  return {
    agentId: opts.agentId,
    channelContext: opts.channelContext,
    promptHook: opts.promptHook,
    threshold: STREAM_DEFAULTS.threshold,
    minLength: band.min,
    maxLength: band.max,
    maxClips: STREAM_DEFAULTS.maxClips,
    minGap: STREAM_DEFAULTS.minGap,
    length,
  };
}

/** Short, Standard, or Long. Anything else, including a missing value, is Standard. */
export function parseStreamLength(value: unknown): StreamLengthId {
  if (value === "short" || value === "standard" || value === "long") return value;
  return "standard";
}

/** Reviewers offered in the Stream picker. `auto` = heuristic scoring,
 * no agent CLI. Ids must match `AGENTS` in agent_edit.py. */
export const STREAM_REVIEW_MODELS = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "agy", name: "AGY" },
  { id: "grok", name: "Grok" },
  { id: "auto", name: "Auto score" },
] as const;

export type StreamReviewModelId =
  (typeof STREAM_REVIEW_MODELS)[number]["id"];

/** Availability snapshot for one review-model dropdown row. */
export interface ReviewModelState {
  available: boolean | null;
  probing: boolean;
}

/** Dropdown row for a review model: unavailable CLIs are labeled and
 * disabled so a dead model can never be picked; `auto` always works. */
export function reviewModelOption(
  model: { id: string; name: string },
  state: ReviewModelState,
): { value: string; label: string; disabled: boolean } {
  if (state.probing || state.available === null) {
    return { value: model.id, label: model.name, disabled: false };
  }
  if (state.available) {
    return { value: model.id, label: `${model.name} ✓`, disabled: false };
  }
  return {
    value: model.id,
    label: `${model.name} — unavailable`,
    disabled: true,
  };
}

export const STREAM_DEFAULTS = {
  threshold: 0.65,
  maxClips: 12,
  minGap: 30,
} as const;

export const STREAM_LENGTHS = {
  short: { label: "Short", hint: "15–30s", min: 15, max: 30 },
  standard: { label: "Standard", hint: "20–45s", min: 20, max: 45 },
  long: { label: "Long", hint: "30–60s", min: 30, max: 60 },
} as const;

export type StreamLengthId = keyof typeof STREAM_LENGTHS;

/** Short framing: auto-detect, a smart single crop, face + screen split
 * stacks, or a full-frame face zoom. The engine always auto-detects the
 * face — there is no manual face-source picker; picking a framing is
 * enough for a proper cut. */
export const STREAM_LAYOUTS = [
  { id: "auto", name: "Auto framing" },
  { id: "single", name: "Single crop" },
  { id: "screen-top", name: "Screen top + Face bottom" },
  { id: "face-top", name: "Face top + Screen bottom" },
  { id: "face-only", name: "Face only" },
] as const;

export type StreamLayoutId = (typeof STREAM_LAYOUTS)[number]["id"];

export function isSplitStreamLayout(layout: string): boolean {
  return layout === "screen-top" || layout === "face-top";
}

/** Framings composed for the 9:16 canvas only: square and wide renders
 * fall back to the smart single crop. `auto` passes through — the engine
 * resolves it per input (and collapses splits off-vertical itself). */
export function needsNineSixteenCanvas(layout: string): boolean {
  return isSplitStreamLayout(layout) || layout === "face-only";
}

/** Output aspect ratio: controls the render canvas dimensions. */
export const STREAM_ASPECT_RATIOS = [
  { id: "9:16", name: "9:16 Vertical", hint: "Shorts / Reels / TikTok", width: 1080, height: 1920 },
  { id: "1:1", name: "1:1 Square", hint: "Feed posts", width: 1080, height: 1080 },
  { id: "16:9", name: "16:9 Wide", hint: "YouTube / landscape", width: 1920, height: 1080 },
] as const;

export type StreamAspectRatioId = (typeof STREAM_ASPECT_RATIOS)[number]["id"];

export function parseAspectRatio(value: unknown): StreamAspectRatioId {
  const key = String(value ?? "").trim();
  if (key === "1:1" || key === "16:9" || key === "9:16") return key;
  return "9:16";
}

export function aspectDims(aspect: string): { width: number; height: number } {
  const found = STREAM_ASPECT_RATIOS.find((a) => a.id === aspect);
  if (found) return { width: found.width, height: found.height };
  return { width: 1080, height: 1920 };
}

/** Split and face-only stacks are composed for the 9:16 canvas; other
 * ratios render the smart single crop. `auto` passes through so the
 * engine can resolve it per input. */
export function effectiveLayoutForAspect(layout: string, aspect: string): string {
  if (parseAspectRatio(aspect) !== "9:16" && needsNineSixteenCanvas(layout)) return "single";
  return layout;
}

/** True when a probe/suggest failure means "still live" (not a real error):
 * the link is fine, the VOD just is not ready. Callers branch into
 * watch-for-VOD mode instead of showing a dead-end error. */
export function isLiveStreamError(message: unknown): boolean {
  return /live right now/i.test(
    message instanceof Error ? message.message : String(message ?? ""),
  );
}

export function isYoutubeUrl(url: string): boolean {
  try {
    const parsed = new URL((url || "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password || parsed.port) return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be" ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com")
    ) {
      return true;
    }
    if (host === "twitch.tv" || host.endsWith(".twitch.tv")) {
      return parsed.pathname.includes("/videos/");
    }
    return false;
  } catch {
    return false;
  }
}

/** mm:ss or h:mm:ss for clip cards and timecodes. */
export function formatClipTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export function formatClipRange(start: number, end: number): string {
  return `${formatClipTime(start)}–${formatClipTime(end)}`;
}

/** `final_short.mp4` + clip 3 → `final_short_clip3.mp4` (dir prefix kept). */
export function clipOutputPath(basePath: string, index: number): string {
  const base = (basePath || "").trim() || "final_short.mp4";
  const extIndex = base.lastIndexOf(".");
  const stem = extIndex >= 0 ? base.slice(0, extIndex) : base;
  const ext = extIndex >= 0 ? base.slice(extIndex) : ".mp4";
  return `${stem}_clip${index + 1}${ext}`;
}

/** Directory prefix of a path (`""` when relative), for clip work files. */
export function dirPrefixOf(path: string): string {
  const clean = (path || "").trim();
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return slash >= 0 ? clean.slice(0, slash + 1) : "";
}

/** True for POSIX `/...` and Windows `C:\...` / `C:/...` roots. */
export function isAbsoluteMediaPath(path: string): boolean {
  const clean = (path || "").trim();
  return clean.startsWith("/") || /^[A-Za-z]:[\\/]/.test(clean);
}

/** Join a directory prefix with a clip file name.
 *
 * Relative prefixes (YouTube-only studio: empty input/output) are dropped
 * so the native helper can place the file in `~/.2pixelshorts/clips`. */
export function clipWorkPath(dirPrefix: string, fileName: string): string {
  const name = (fileName || "").trim();
  if (!name) return "";
  const dir = dirPrefix || "";
  if (!dir || !isAbsoluteMediaPath(dir)) return name;
  if (dir.endsWith("/") || dir.endsWith("\\")) return `${dir}${name}`;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir}${sep}${name}`;
}

/** Prefer the absolute path the helper actually wrote. */
export function resolvedClipOutput(fetched: CommandOutput, requested: string): string {
  const text = (fetched.stdout || "").trim();
  if (!text) return requested;
  const tryParse = (raw: string): string | null => {
    try {
      const parsed = JSON.parse(raw) as { output?: unknown };
      return typeof parsed.output === "string" && parsed.output.trim()
        ? parsed.output.trim()
        : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const nested = tryParse(text.slice(start, end + 1));
    if (nested) return nested;
  }
  return requested;
}

/** One selected stream window to download as a Studio source. */
export interface StreamClipImportSpec {
  start: number;
  end: number;
  /** Skip-toast label (`Clip 3`). */
  label: string;
  /** Sidebar title once imported (clip reason). */
  title: string;
  outputName: string;
}

export interface ImportedClipFile {
  inputPath: string;
  metadata: VideoMetadata | null;
  title: string;
}

/**
 * Download each selected window on its own. A throw or yt-dlp miss on
 * one clip must not discard clips that already landed on disk.
 */
export async function downloadStreamClipsAsSources(opts: {
  url: string;
  dirPrefix: string;
  clips: StreamClipImportSpec[];
  fetchClip?: (
    url: string,
    start: number,
    end: number,
    output: string,
  ) => Promise<CommandOutput>;
  probe?: (path: string) => Promise<VideoMetadata>;
  onProgress?: (current: number, total: number) => void;
  onSkip?: (label: string, message: string) => void;
}): Promise<ImportedClipFile[]> {
  const fetchClip = opts.fetchClip ?? fetchStreamClip;
  const imported: ImportedClipFile[] = [];
  const total = opts.clips.length;
  for (let n = 0; n < total; n++) {
    const clip = opts.clips[n];
    opts.onProgress?.(n + 1, total);
    const requested = clipWorkPath(opts.dirPrefix, clip.outputName);
    try {
      const fetched = await fetchClip(opts.url, clip.start, clip.end, requested);
      if (!fetched.success) {
        opts.onSkip?.(
          clip.label,
          fetched.stderr.trim().slice(0, 220) || "clip download failed",
        );
        continue;
      }
      const inputPath = resolvedClipOutput(fetched, requested);
      let metadata: VideoMetadata | null = null;
      if (opts.probe) {
        try {
          metadata = await opts.probe(inputPath);
        } catch {
          metadata = null;
        }
      }
      imported.push({ inputPath, metadata, title: clip.title });
    } catch (err) {
      opts.onSkip?.(
        clip.label,
        err instanceof Error ? err.message : "clip download failed",
      );
    }
  }
  return imported;
}

function toResult(raw: {
  url: string;
  title: string;
  channel: string;
  duration: number;
  transcript_source: string;
  words_count: number;
  picker?: string;
  picker_note?: string;
  clips: StreamClip[];
}): SuggestStreamClipsResult {
  return {
    url: raw.url,
    title: raw.title,
    channel: raw.channel,
    duration: raw.duration,
    transcriptSource: raw.transcript_source,
    wordsCount: raw.words_count,
    picker: raw.picker || "heuristic",
    pickerNote: raw.picker_note || "",
    clips: raw.clips,
  };
}

export async function probeStream(url: string): Promise<StreamProbe> {
  const clean = url.trim();
  if (isTauri()) {
    return await invoke<StreamProbe>("probe_stream", { url: clean });
  }
  throw new Error("Open the 2pixelshorts desktop app to analyze and download source footage with video-use.");
}

export async function suggestStreamClips(
  url: string,
  opts: SuggestStreamClipsOptions = {},
): Promise<SuggestStreamClipsResult> {
  const clean = url.trim();
  if (isTauri()) {
    const raw = await invoke<{
      url: string;
      title: string;
      channel: string;
      duration: number;
      transcript_source: string;
      words_count: number;
      picker?: string;
      picker_note?: string;
      clips: StreamClip[];
    }>("suggest_stream_clips", {
      url: clean,
      ...transcriptionInvokeParams(opts.elevenlabsKey, opts.transcriptionProvider),
      agentId: opts.agentId || null,
      channelContext: opts.channelContext || null,
      promptHook: opts.promptHook || null,
      threshold: opts.threshold ?? null,
      minLength: opts.minLength ?? null,
      maxLength: opts.maxLength ?? null,
      maxClips: opts.maxClips ?? null,
      minGap: opts.minGap ?? null,
    });
    return toResult(raw);
  }
  throw new Error("Open the 2pixelshorts desktop app to analyze and download source footage with video-use.");
}

export async function fetchStreamClip(
  url: string,
  start: number,
  end: number,
  output: string,
): Promise<CommandOutput> {
  if (isTauri()) {
    return await invoke<CommandOutput>("fetch_stream_clip", {
      url: url.trim(),
      start,
      end,
      output,
    });
  }
  throw new Error("Open the 2pixelshorts desktop app to analyze and download source footage with video-use.");
}
