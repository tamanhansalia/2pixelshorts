import type { JobStatus, VideoMetadata, VideoReviewReport } from "../types/index.ts";
import { normalizeEditStrategy, type EditStrategy } from "./studioAutomation.ts";
import { resolveStudioStage, type StudioStage } from "./studioWorkflow.ts";
import type { RenderHistoryEntry } from "./renderHistory.ts";
import { isActiveRenderStatus } from "./renderHistory.ts";

/**
 * Studio sources (projects): every imported video keeps its edit state and
 * SEO metadata, so leaving the Studio tab never loses work and the sidebar
 * can list each source with its status. Clicking a source reopens Studio
 * at the saved stage, with the same edit and publishing choices.
 */

export interface StudioProjectDraft {
  inputPath: string;
  aspectRatio?: string;
  studioStage?: StudioStage;
  layout?: string;
  outputPath: string;
  /** True once the user edits the output name by hand. Untouched drafts
   * auto-derive the name (Shorts title → stream title → input file). */
  outputTouched: boolean;
  metadata: VideoMetadata | null;
  presetId: string;
  agentId: string;
  editStrategy?: EditStrategy;
  removeSilence?: boolean;
  removeRetakes?: boolean;
  highlightTarget?: number;
  /** Legacy manual-trim fields; Studio no longer reads or writes them. */
  cutStartInput?: string;
  cutEndInput?: string;
  burnInCaptions: boolean;
  subtitleStyle: string;
  subtitlePosition: string;
  subtitleSize: string;
  subtitleCase: string;
  promptHook: string;
  customInstructionsEnabled?: boolean;
  modelId?: string;
  contextOverride: string;
  seoTitle: string;
  seoDescription: string;
  seoTags: string[];
  /** Full package spares: alternates/hashtags/scores survive tab switches. */
  seoTitleAlternatives?: string[];
  seoHashtags?: string[];
  seoScore?: number | null;
  seoQualityScore?: number | null;
  seoKeywords?: string[];
  /** The searches this short should win, and its pinned first comment. */
  seoSearchQueries?: string[];
  /**
   * External searches only. An empty array means the engine composed
   * the phrases from speech. Missing means an older package.
   */
  seoDemandQueries?: string[];
  seoPinnedComment?: string;
  reviewReport: VideoReviewReport | null;
  updatedAt: string;
  /** Set once when the short is started; drives sidebar day grouping. Never rewritten by edits. */
  createdAt: string;
}

export interface StudioStore {
  projects: Record<string, StudioProjectDraft>;
  /** Most-recently-touched input paths first. */
  recent: string[];
  currentId: string | null;
}

export const STUDIO_STORE_KEY = "2pixel_studio_projects";
/** A week-plus of shorts at several renders a day; older bodies are dropped first. */
export const MAX_STUDIO_PROJECTS = 30;

export type SourceStatus =
  | "editing"
  | "queued"
  | "rendering"
  | "completed"
  | "failed";

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Directory prefix of a path (`""` when relative), kept for auto names. */
export function dirOf(path: string): string {
  const clean = (path || "").trim();
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return slash >= 0 ? clean.slice(0, slash + 1) : "";
}

/** Strip the extension off a file name (`vid.mp4` → `vid`). */
export function stemOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

/** Make a title safe for a file stem: keep letters/numbers (any
 * language), drop emoji and punctuation, spaces to `_`, capped at 60
 * chars so paths stay sane. */
export function slugifyTitle(title: string): string {
  const slug = (title || "")
    .replace(/[^\p{L}\p{N}\s_-]+/gu, "")
    .replace(/[\s_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/g, "");
  return slug;
}

export interface OutputSuggestion {
  /** Full output path, always ending in `.mp4`. */
  path: string;
  /** Which input named it: the Shorts title, the stream title, the
   * source file, or the last-resort default. */
  source: "title" | "stream" | "input" | "default";
}

/** File name for a stream clip imported as its own source: title-based
 * when the stream has a usable title, otherwise a timestamp fallback.
 * The 1-based index keeps every clip of one import distinct. Pure for
 * testability. */
export function streamClipSourceName(
  streamTitle: string,
  stamp: number,
  index: number,
): string {
  const base = slugifyTitle(streamTitle) || `stream_src_${stamp}`;
  return `${base}_clip${index + 1}.mp4`;
}

/** Auto output name: Shorts title wins, then the stream video title,
 * then `<input>_short`, then `final_short`. The source file's folder is
 * kept so renders land next to their footage. Pure for testability. */
export function suggestOutputPath(opts: {
  seoTitle?: string;
  streamTitle?: string;
  inputPath?: string;
}): OutputSuggestion {
  const dir = dirOf(opts.inputPath ?? "");
  const titleSlug = slugifyTitle(opts.seoTitle ?? "");
  if (titleSlug) return { path: `${dir}${titleSlug}.mp4`, source: "title" };
  const streamSlug = slugifyTitle(opts.streamTitle ?? "");
  if (streamSlug) return { path: `${dir}${streamSlug}.mp4`, source: "stream" };
  const base = baseName((opts.inputPath ?? "").trim());
  if (base) return { path: `${dir}${stemOf(base)}_short.mp4`, source: "input" };
  return { path: "final_short.mp4", source: "default" };
}

export function emptyStudioStore(): StudioStore {
  return { projects: {}, recent: [], currentId: null };
}

/** A fresh, untouched short: empty source, default style, blank SEO.
 * The output name stays auto-derived until the user edits it in Render. */
export function blankStudioDraft(): StudioProjectDraft {
  return {
    inputPath: "",
    aspectRatio: "9:16",
    outputPath: "",
    outputTouched: false,
    metadata: null,
    presetId: "warm_cinematic",
    agentId: "claude",
    editStrategy: "cleanup",
    removeSilence: true,
    removeRetakes: true,
    highlightTarget: 30,
    cutStartInput: "",
    cutEndInput: "",
    burnInCaptions: true,
    subtitleStyle: "pop",
    subtitlePosition: "bottom",
    subtitleSize: "standard",
    subtitleCase: "uppercase",
    promptHook: "",
    contextOverride: "",
    seoTitle: "",
    seoDescription: "",
    seoTags: [],
    reviewReport: null,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

/** Downloaded stream windows ready to become sidebar sources. */
export interface ImportedClipSource {
  inputPath: string;
  metadata: VideoMetadata | null;
  title?: string;
}

/** Insert selected clip downloads as fresh Studio drafts.
 *
 * First clip in `clips` becomes current (opens in Studio). Reverse upsert
 * so the sidebar keeps clip-finder order, most-recent-first. */
export function importClipDrafts(
  store: StudioStore,
  clips: ImportedClipSource[],
  now = new Date().toISOString(),
): StudioStore {
  const valid = clips.filter((clip) => clip.inputPath.trim());
  if (valid.length === 0) return store;
  let next = store;
  for (const clip of [...valid].reverse()) {
    const title = (clip.title || "").trim();
    const draft: StudioProjectDraft = {
      ...blankStudioDraft(),
      inputPath: clip.inputPath,
      metadata: clip.metadata,
      seoTitle: title,
      studioStage: clip.metadata ? "edit" : "source",
      updatedAt: now,
      createdAt: now,
    };
    next = upsertDraft(next, draft);
  }
  return { ...next, currentId: valid[0].inputPath };
}

/** Insert or replace a draft and move its path to the front of recents. */
export function upsertDraft(store: StudioStore, draft: StudioProjectDraft): StudioStore {
  // createdAt is pinned on first save: later edits must not move the short to a new day.
  const prev = store.projects[draft.inputPath];
  const createdAt = prev?.createdAt ?? draft.createdAt ?? new Date().toISOString();
  const projects = { ...store.projects, [draft.inputPath]: { ...draft, createdAt } };
  const recent = [
    draft.inputPath,
    ...store.recent.filter((id) => id !== draft.inputPath),
  ].slice(0, MAX_STUDIO_PROJECTS);
  // Drop project bodies that fell out of recents (except the current one,
  // which may briefly lag behind while switching).
  const keep = new Set([...recent, store.currentId].filter(Boolean) as string[]);
  for (const id of Object.keys(projects)) {
    if (!keep.has(id)) delete projects[id];
  }
  return { projects, recent, currentId: store.currentId };
}

export function selectSource(store: StudioStore, id: string): StudioStore {
  return { ...store, currentId: id };
}

/** Remove one source: drops its draft + recent entry, clears current if needed. */
export function removeSource(store: StudioStore, id: string): StudioStore {
  if (!store.recent.includes(id) && !(id in store.projects)) return store;
  const projects = { ...store.projects };
  delete projects[id];
  const recent = store.recent.filter((entry) => entry !== id);
  const currentId = store.currentId === id ? null : store.currentId;
  return { projects, recent, currentId };
}

/** Prefill a draft from a schedule-queue item (upload SEO included). */
export function buildDraftFromQueue(item: {
  video_path: string;
  title: string;
  description?: string;
  tags?: string[];
}): StudioProjectDraft {
  return {
    inputPath: item.video_path,
    aspectRatio: "9:16",
    outputPath: item.video_path,
    // A queue path is an explicit existing file, not an auto name.
    outputTouched: true,
    metadata: null,
    presetId: "warm_cinematic",
    agentId: "claude",
    editStrategy: "cleanup",
    removeSilence: true,
    removeRetakes: true,
    highlightTarget: 30,
    cutStartInput: "",
    cutEndInput: "",
    burnInCaptions: true,
    subtitleStyle: "pop",
    subtitlePosition: "bottom",
    subtitleSize: "standard",
    subtitleCase: "sentence",
    promptHook: "",
    contextOverride: "",
    seoTitle: item.title || "",
    seoDescription: item.description || "",
    seoTags: item.tags ? [...item.tags] : [],
    reviewReport: null,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Merge a finished background analysis into the matching draft, so a
 * result that lands while Studio is on another tab is visible on return.
 * Matches by input path or output path; unknown targets leave the store
 * untouched. Pure for testability.
 */
export function applyStudioSeo(
  store: StudioStore,
  targetVideo: string,
  meta: {
    title: string;
    description: string;
    tags: string[];
    title_alternatives?: string[];
    hashtags?: string[];
    seo_score?: number | null;
    quality_score?: number | null;
    keywords_analyzed?: string[];
    search_queries?: string[];
    demand_queries?: string[];
    pinned_comment?: string;
    review_report?: VideoReviewReport | null;
  },
): StudioStore {
  if (!targetVideo) return store;
  const id =
    Object.keys(store.projects).find(
      (key) =>
        key === targetVideo ||
        store.projects[key]?.outputPath === targetVideo,
    ) ?? null;
  if (!id) return store;
  const draft = store.projects[id];
  return {
    ...store,
    projects: {
      ...store.projects,
      [id]: {
        ...draft,
        seoTitle: meta.title,
        seoDescription: meta.description,
        seoTags: [...meta.tags],
        seoTitleAlternatives: meta.title_alternatives
          ? [...meta.title_alternatives]
          : [],
        seoHashtags: meta.hashtags ? [...meta.hashtags] : [],
        seoScore: meta.seo_score ?? null,
        seoQualityScore: meta.quality_score ?? null,
        seoKeywords: meta.keywords_analyzed
          ? [...meta.keywords_analyzed]
          : [],
        seoSearchQueries: meta.search_queries ? [...meta.search_queries] : [],
        seoDemandQueries: Array.isArray(meta.demand_queries)
          ? [...meta.demand_queries]
          : draft.seoDemandQueries,
        seoPinnedComment: meta.pinned_comment ?? "",
        reviewReport: meta.review_report ?? draft.reviewReport,
        updatedAt: new Date().toISOString(),
      },
    },
  };
}

/** Sidebar order: studio recents first, then queued paths not already listed. */
export function mergeSourceIds(recent: string[], queuePaths: string[]): string[] {
  const seen = new Set(recent);
  const merged = [...recent];
  for (const p of queuePaths) {
    if (p && !seen.has(p)) {
      seen.add(p);
      merged.push(p);
    }
  }
  return merged;
}

function historyStatusFor(
  path: string,
  history: Pick<RenderHistoryEntry, "inputVideo" | "outputVideo" | "status" | "progress">[],
): { status: JobStatus; progress: number } | null {
  // Newest-first history wins: the first entry touching this path decides.
  for (const h of history) {
    if (h.inputVideo === path || h.outputVideo === path) {
      return { status: h.status, progress: h.progress };
    }
  }
  return null;
}

export function resolveSourceStatus(
  path: string,
  history: Pick<RenderHistoryEntry, "inputVideo" | "outputVideo" | "status" | "progress">[],
  queuePaths: string[],
): { status: SourceStatus; progress?: number } {
  const match = historyStatusFor(path, history);
  if (match) {
    if (isActiveRenderStatus(match.status)) {
      return { status: "rendering", progress: match.progress };
    }
    if (match.status === "completed") return { status: "completed" };
    if (match.status === "failed") return { status: "failed" };
    return { status: "editing" };
  }
  if (queuePaths.includes(path)) return { status: "queued" };
  return { status: "editing" };
}

/**
 * One sidebar row per short (concept C): a studio source merged with the
 * render output it produced, so input + output never occupy two rows.
 * Queue-only paths (outputs whose source draft is gone) stand alone.
 */
export interface SourceEntry {
  /** Stable row key: the studio input path, or the queue path when sourceless. */
  id: string;
  /** Sidebar name: SEO title when present, otherwise the file name. */
  label: string;
  createdAt: string;
  status: SourceStatus;
  progress?: number;
  /** Display paths, input first: shown as `source → output` when merged. */
  files: string[];
  /** Studio project key when this row owns a draft; null for queue-only rows. */
  projectId: string | null;
  /** Queue video_paths removed alongside this row. */
  queuePaths: string[];
}

export interface QueueRef {
  video_path: string;
  created_at: string;
  /** Queue SEO title, used for sourceless rows. */
  title?: string;
}

type HistoryRef = Pick<
  RenderHistoryEntry,
  "inputVideo" | "outputVideo" | "status" | "progress" | "createdAt" | "seo"
>;

/**
 * Sidebar short name: the Title & tags SEO title wins, then a queued
 * title, then the title captured on the newest matching render, then
 * the file name. Trim-empty strings fall through.
 */
/**
 * Agent CLI Title & tags should use, independent of edit mode.
 * Newest draft with a real CLI wins; otherwise Claude (engine falls back
 * to composed Auto-cut titles when that CLI is missing).
 */
export function preferredSeoAgent(
  store: StudioStore,
  fallback = "claude",
): string | undefined {
  const rows = Object.values(store.projects)
    .filter((draft) => draft.agentId && draft.agentId !== "auto")
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  const id = rows[0]?.agentId || fallback;
  return !id || id === "auto" ? undefined : id;
}

export function sourceLabel(opts: {
  seoTitle?: string;
  queueTitle?: string;
  historyTitle?: string;
  fallbackPath: string;
}): string {
  const seo = opts.seoTitle?.trim();
  if (seo) return seo;
  const queued = opts.queueTitle?.trim();
  if (queued) return queued;
  const hist = opts.historyTitle?.trim();
  if (hist) return hist;
  return baseName(opts.fallbackPath);
}

function historyTitleFor(files: string[], history: HistoryRef[]): string {
  for (const h of history) {
    const title = h.seo?.title?.trim();
    if (!title) continue;
    if (files.includes(h.inputVideo) || files.includes(h.outputVideo)) {
      return title;
    }
  }
  return "";
}

/**
 * The file actually on disk for this input: the newest *completed* render's
 * output. History is newest-first, so the first completed match wins;
 * running/failed entries have no finished file to play or reveal.
 */
export function latestCompletedOutput(
  input: string,
  history: Pick<RenderHistoryEntry, "inputVideo" | "outputVideo" | "status">[],
): string | null {
  if (!input) return null;
  for (const h of history) {
    if (h.inputVideo === input && h.status === "completed" && h.outputVideo) {
      return h.outputVideo;
    }
  }
  return null;
}

/**
 * Auto-naming may only steer the *next* render's target. Once a render is
 * on disk it must never rename `outputPath` — the rendered file keeps its
 * name, and retargeting the path would point Play/Reveal/queue actions at
 * a title-slug file that was never written.
 */
export function shouldAutoNameOutput(
  outputTouched: boolean,
  renderedOutput: string | null,
): boolean {
  return !outputTouched && !renderedOutput;
}

/** Newest history output produced from this input, else the draft's own target output. */
export function linkedOutputFor(
  input: string,
  history: HistoryRef[],
  projectOutput?: string,
): string | null {
  for (const h of history) {
    if (h.inputVideo === input && h.outputVideo && h.outputVideo !== input) {
      return h.outputVideo;
    }
  }
  if (projectOutput && projectOutput !== input) return projectOutput;
  return null;
}

function historyCreatedFor(
  files: string[],
  history: HistoryRef[],
): string | null {
  for (const h of history) {
    if (files.includes(h.inputVideo) || files.includes(h.outputVideo)) {
      return h.createdAt;
    }
  }
  return null;
}

/** Status across every file a merged row covers; the first (newest) history touch wins. */
export function resolveEntryStatus(
  files: string[],
  history: Pick<RenderHistoryEntry, "inputVideo" | "outputVideo" | "status" | "progress">[],
  queuePaths: string[],
): { status: SourceStatus; progress?: number } {
  for (const h of history) {
    if (!files.includes(h.inputVideo) && !files.includes(h.outputVideo)) continue;
    if (isActiveRenderStatus(h.status)) {
      return { status: "rendering", progress: h.progress };
    }
    if (h.status === "completed") return { status: "completed" };
    if (h.status === "failed") return { status: "failed" };
    break;
  }
  if (files.some((f) => queuePaths.includes(f))) return { status: "queued" };
  return { status: "editing" };
}

export function buildSourceEntries(
  recent: string[],
  projects: Record<string, StudioProjectDraft>,
  history: HistoryRef[],
  queue: QueueRef[],
): SourceEntry[] {
  const queuePaths = queue.map((q) => q.video_path);
  const entries: SourceEntry[] = [];
  const covered = new Set<string>();
  for (const id of recent) {
    const draft = projects[id];
    const linked = linkedOutputFor(id, history, draft?.outputPath);
    const files = linked ? [id, linked] : [id];
    files.forEach((f) => covered.add(f));
    const resolved = resolveEntryStatus(files, history, queuePaths);
    entries.push({
      id,
      label: sourceLabel({
        seoTitle: draft?.seoTitle,
        historyTitle: historyTitleFor(files, history),
        fallbackPath: linked ?? draft?.outputPath ?? draft?.inputPath ?? id,
      }),
      createdAt:
        draft?.createdAt ?? historyCreatedFor(files, history) ?? new Date().toISOString(),
      status: resolved.status,
      progress: resolved.progress,
      files,
      projectId: draft ? id : null,
      queuePaths: files.filter((f) => queuePaths.includes(f)),
    });
  }
  // Queue rows whose source draft is gone (or never existed) stand alone,
  // newest queued first.
  const orphans = queue
    .filter((q) => q.video_path && !covered.has(q.video_path))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  for (const q of orphans) {
    const resolved = resolveEntryStatus([q.video_path], history, queuePaths);
    entries.push({
      id: q.video_path,
      label: sourceLabel({
        queueTitle: q.title,
        historyTitle: historyTitleFor([q.video_path], history),
        fallbackPath: q.video_path,
      }),
      createdAt: q.created_at,
      status: resolved.status,
      progress: resolved.progress,
      files: [q.video_path],
      projectId: null,
      queuePaths: [q.video_path],
    });
  }
  return entries;
}

export interface DayGroup {
  /** Local `yyyy-mm-dd`, or `older`. Stable across days so collapse state persists. */
  key: string;
  label: string;
  sub: string;
}

function localDateKey(t: number): string {
  const d = new Date(t);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today / Yesterday / weekday / Older for an ISO timestamp. Invalid input sorts as Older. */
export function dayGroupFor(iso: string, nowMs: number = Date.now()): DayGroup {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { key: "older", label: "Older", sub: "" };
  const dayMs = 86_400_000;
  const diff = Math.round((startOfLocalDay(nowMs) - startOfLocalDay(t)) / dayMs);
  const dateSub = new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  if (diff <= 0) return { key: localDateKey(t), label: "Today", sub: dateSub };
  if (diff === 1) return { key: localDateKey(t), label: "Yesterday", sub: dateSub };
  if (diff < 7) {
    return {
      key: localDateKey(t),
      label: new Date(t).toLocaleDateString("en-US", { weekday: "long" }),
      sub: dateSub,
    };
  }
  return { key: "older", label: "Older", sub: "" };
}

/** Bucket entries into day groups, newest group first, entry order kept within. */
export function groupEntriesByDay(
  entries: SourceEntry[],
  nowMs: number = Date.now(),
): { group: DayGroup; entries: SourceEntry[] }[] {
  const order = new Map<string, { group: DayGroup; entries: SourceEntry[] }>();
  for (const entry of entries) {
    const group = dayGroupFor(entry.createdAt, nowMs);
    const bucket = order.get(group.key);
    if (bucket) bucket.entries.push(entry);
    else order.set(group.key, { group, entries: [entry] });
  }
  const rank = (key: string): [number, string] =>
    key === "older" ? [1, ""] : [0, key];
  return [...order.values()].sort((a, b) => {
    const [ra, ka] = rank(a.group.key);
    const [rb, kb] = rank(b.group.key);
    if (ra !== rb) return ra - rb;
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
}

/**
 * Backfill timestamps on stored drafts from before `createdAt` existed
 * (falls back to `updatedAt`, then now). Pure for testability.
 */
export function normalizeStudioStore(store: StudioStore): StudioStore {
  const fallback = new Date().toISOString();
  const projects: Record<string, StudioProjectDraft> = {};
  for (const id of Object.keys(store.projects)) {
    const draft = store.projects[id] as Partial<StudioProjectDraft>;
    // Drafts stored before outputTouched existed keep their saved name:
    // anything beyond the blank default counts as user-chosen.
    const outputPath = draft.outputPath ?? "";
    projects[id] = {
      ...(draft as StudioProjectDraft),
      outputPath,
      editStrategy: normalizeEditStrategy(draft.editStrategy ?? (draft.promptHook?.trim() ? "custom" : undefined)),
      promptHook: draft.promptHook ?? "",
      customInstructionsEnabled: draft.customInstructionsEnabled ?? (draft.editStrategy === "custom" || (!draft.editStrategy && Boolean(draft.promptHook?.trim()))),
      modelId: draft.modelId ?? "",
      studioStage: resolveStudioStage(draft.studioStage, Boolean(draft.metadata)),
      removeSilence: draft.removeSilence ?? true,
      removeRetakes: draft.removeRetakes ?? true,
      highlightTarget: [30, 60, 90].includes(draft.highlightTarget ?? 0) ? draft.highlightTarget : 30,
      outputTouched:
        draft.outputTouched ??
        (outputPath.trim() !== "" && outputPath !== "final_short.mp4"),
      createdAt: draft.createdAt ?? draft.updatedAt ?? fallback,
    };
  }
  return { ...store, projects };
}

export function loadStudioStore(): StudioStore {
  try {
    if (typeof localStorage === "undefined") return emptyStudioStore();
    const raw = localStorage.getItem(STUDIO_STORE_KEY);
    if (!raw) return emptyStudioStore();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return emptyStudioStore();
    const obj = parsed as Partial<StudioStore>;
    if (typeof obj.projects !== "object" || obj.projects === null) {
      return emptyStudioStore();
    }
    const recent = Array.isArray(obj.recent)
      ? obj.recent.filter((id): id is string => typeof id === "string")
      : [];
    return normalizeStudioStore({
      projects: obj.projects as Record<string, StudioProjectDraft>,
      recent,
      currentId: typeof obj.currentId === "string" ? obj.currentId : null,
    });
  } catch {
    return emptyStudioStore();
  }
}

export function saveStudioStore(store: StudioStore): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STUDIO_STORE_KEY, JSON.stringify(store));
  } catch {
    // Best-effort persistence.
  }
}
