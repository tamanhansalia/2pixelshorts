import type {
  ScheduleItem,
  SeoMetadata,
  SocialPublishPayload,
} from "../types/index.ts";
import type { RenderHistoryEntry } from "./renderHistory.ts";

/**
 * Local-first posting outbox: scheduling a short always lands in the
 * queue immediately (no gateway round-trip required), and every dispatch
 * attempt — from Social or from the Queue page — is recorded there with
 * its outcome so failures stay visible and retryable.
 */

/**
 * Single scheduling-defaults source: every schedule form, queue entry,
 * and toast falls back to these instead of hardcoding "UTC" / "18:00".
 */
export const DEFAULT_TIMEZONE = "UTC";
export const DEFAULT_RELEASE_TIME = "18:00";

/**
 * Split "YYYY-MM-DDTHH:mm…" into editable date + time parts. Accepts
 * seconds, fractional seconds, and Z/offset suffixes
 * ("2026-10-10T18:00:00Z", "2026-10-10 18:00:00.000+05:30"); a date-only
 * value keeps its date with the default time. Anything else yields a
 * blank date + default time.
 */
export function splitSchedule(iso?: string | null): {
  date: string;
  time: string;
} {
  const text = (iso ?? "").trim();
  const m = text.match(
    /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/,
  );
  if (m?.[1] && m?.[2]) return { date: m[1], time: m[2] };
  const d = text.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (d?.[1]) return { date: d[1], time: DEFAULT_RELEASE_TIME };
  return { date: "", time: DEFAULT_RELEASE_TIME };
}

/** Release-slot parts for queue rows; unparseable input echoes raw. */
export function formatRelease(iso: string): { day: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: iso, time: "" };
  return {
    day: d.toLocaleDateString([], { month: "short", day: "numeric" }),
    time: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };
}

/**
 * Single-line release label for toasts and messages. Never renders
 * "Invalid Date": valid input → locale string, non-empty garbage → the
 * raw text, empty → fallback.
 */
export function formatScheduledLabel(iso?: string | null): string {
  const text = (iso ?? "").trim();
  if (!text) return "unknown time";
  const d = new Date(text);
  if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  return text;
}

/** Build a queued entry from a Social payload. Never touches the network. */
export function newScheduleItem(payload: SocialPublishPayload): ScheduleItem {
  return {
    id: `job-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    title: payload.title,
    video_path: payload.video_path,
    platforms: [...payload.platforms],
    scheduled_for:
      payload.scheduled_for ??
      new Date(Date.now() + 3 * 60 * 1000).toISOString(),
    timezone: payload.timezone || DEFAULT_TIMEZONE,
    status: "queued",
    created_at: new Date().toISOString(),
    description: payload.description,
    tags: payload.tags ? [...payload.tags] : undefined,
    account_ids: payload.account_ids ? [...payload.account_ids] : undefined,
    error: null,
  };
}

export interface OutputSeo {
  title?: string;
  description?: string;
  tags?: string[];
}

/**
 * Payload for queueing a finished render output: meta-page SEO wins,
 * otherwise the title falls back to the file name. Channels are picked
 * later (Queue → Edit) when posting.
 */
export function queuePayloadForOutput(
  outputPath: string,
  seo?: OutputSeo,
): SocialPublishPayload {
  return {
    title:
      seo?.title?.trim() ||
      outputPath
        .split(/[\\/]/)
        .pop()!
        .replace(/\.[^/.]+$/, "")
        .replace(/[-_]+/g, " ")
        .trim()
        .slice(0, 100) ||
      outputPath,
    description: seo?.description ?? "",
    platforms: [],
    video_path: outputPath,
    publish_now: false,
    scheduled_for: undefined,
    timezone: DEFAULT_TIMEZONE,
    tags: seo?.tags ? [...seo.tags] : [],
  };
}

/** Rebuild an immediate-dispatch payload from a stored queue entry. */
export function toPublishPayload(item: ScheduleItem): SocialPublishPayload {
  return {
    title: item.title,
    description: item.description ?? "",
    platforms: item.platforms,
    video_path: item.video_path,
    publish_now: true,
    scheduled_for: undefined,
    timezone: item.timezone,
    account_ids: item.account_ids,
    tags: item.tags,
    // A queued or in-flight attempt keeps one key so a timeout retry returns
    // the original post. A failed attempt must use a new key: the gateway
    // replays the stored failure for 24 hours and never applies a fixed body.
    idempotency_key:
      item.status === "failed" ? `${item.id}:retry:${Date.now()}` : item.id,
  };
}

/**
 * Gate a Queue "Post now": returns the blocking reason, or null when the
 * item can be dispatched (API key set and ≥1 platform chosen).
 */
export function canPostItem(
  item: Pick<ScheduleItem, "platforms">,
  apiKey: string,
): string | null {
  if (!apiKey.trim()) {
    return "Enter your Zernio API key first (Social → API key).";
  }
  if (item.platforms.length === 0) {
    return "Pick channels first — open the row in Social (Edit), select channels, then post.";
  }
  return null;
}

/** A short Social can load: a queue entry, or a finished render not already queued. */
export interface SelectableShort {
  id: string;
  title: string;
  description: string;
  tags: string[];
  videoPath: string;
  source: "queue" | "render";
}

/**
 * Shorts the Social page can publish. Queue entries come first. A finished
 * render is included only when that file is not already in the queue.
 * Titles fall back to the file name so a render can still be selected
 * before it has analyzed SEO.
 */
export function selectableShorts(
  queue: Pick<
    ScheduleItem,
    "id" | "title" | "description" | "tags" | "video_path"
  >[],
  history: Pick<RenderHistoryEntry, "id" | "outputVideo" | "status" | "seo">[],
): SelectableShort[] {
  const shorts: SelectableShort[] = [];
  const seen = new Set<string>();
  for (const item of queue) {
    const path = (item.video_path ?? "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    shorts.push({
      id: item.id,
      title: item.title.trim() || titleForOutput(path),
      description: item.description ?? "",
      tags: item.tags ? [...item.tags] : [],
      videoPath: path,
      source: "queue",
    });
  }
  for (const entry of history) {
    const path = (entry.outputVideo ?? "").trim();
    if (entry.status !== "completed" || !path || seen.has(path)) continue;
    seen.add(path);
    shorts.push({
      id: entry.id,
      title: entry.seo?.title?.trim() || titleForOutput(path),
      description: entry.seo?.description ?? "",
      tags: entry.seo?.tags ? [...entry.seo.tags] : [],
      videoPath: path,
      source: "render",
    });
  }
  return shorts;
}

/**
 * Completed render outputs not yet in the posting queue — the "ready to
 * queue" list on the Queue page. Newest history first, deduped.
 */
export function unqueuedOutputs(
  history: Pick<RenderHistoryEntry, "outputVideo" | "status">[],
  queuePaths: string[],
): string[] {
  const queued = new Set(queuePaths);
  const seen = new Set<string>();
  const ready: string[] = [];
  for (const h of history) {
    if (h.status !== "completed" || !h.outputVideo) continue;
    if (queued.has(h.outputVideo) || seen.has(h.outputVideo)) continue;
    seen.add(h.outputVideo);
    ready.push(h.outputVideo);
  }
  return ready;
}

/** Human title for a queued output: explicit hint wins, else the file name. */
export function titleForOutput(outputPath: string, hint?: string): string {
  if (hint?.trim()) return hint.trim().slice(0, 100);
  const base = outputPath.split(/[\\/]/).pop() || outputPath;
  return (
    base
      .replace(/\.[^/.]+$/, "")
      .replace(/[-_]+/g, " ")
      .trim()
      .slice(0, 100) || outputPath
  );
}

export interface QueueSeoPatch {
  title: string;
  description: string;
  tags: string[];
}

/** Map a fresh SEO review onto a queue entry (platforms/schedule untouched). */
export function buildSeoPatch(
  seo: Pick<SeoMetadata, "title" | "description" | "tags">,
): QueueSeoPatch {
  return {
    title: seo.title,
    description: seo.description,
    tags: [...seo.tags],
  };
}

export interface QuickScheduleInput {
  videoPath: string;
  title: string;
  description: string;
  /** Raw comma-separated tags as typed. */
  tagsText: string;
  scheduledDate: string;
  scheduledTime: string;
  timezone: string;
}

/** Split a comma-separated tags field into a clean, deduped list. */
export function parseTagList(tagsText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of tagsText.split(",")) {
    const tag = part.trim().replace(/^#+/, "");
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * Assemble a schedule payload from the quick-schedule card. Platforms stay
 * empty for later picking (Queue → Edit); the entry always lands queued,
 * never dispatched.
 */
export function buildQuickSchedulePayload(
  input: QuickScheduleInput,
): SocialPublishPayload {
  return {
    title: input.title.trim().slice(0, 100),
    description: input.description.trim(),
    platforms: [],
    video_path: input.videoPath.trim(),
    publish_now: false,
    scheduled_for: `${input.scheduledDate}T${input.scheduledTime || DEFAULT_RELEASE_TIME}:00`,
    timezone: input.timezone || DEFAULT_TIMEZONE,
    tags: parseTagList(input.tagsText),
  };
}

/**
 * Blocking reason for the quick-schedule action, or null when the entry
 * can be queued.
 */
export function quickScheduleBlocker(input: QuickScheduleInput): string | null {
  if (!input.videoPath.trim()) return "Pick a video file first.";
  if (!input.title.trim()) return "Analyze the video (or type a title) first.";
  if (!input.scheduledDate.trim()) return "Pick a release date first.";
  return null;
}

export function markDispatching(
  items: ScheduleItem[],
  id: string,
): ScheduleItem[] {
  return items.map((item) =>
    item.id === id
      ? { ...item, status: "publishing" as const, error: null }
      : item,
  );
}

export function markDispatched(
  items: ScheduleItem[],
  id: string,
  postId?: string,
): ScheduleItem[] {
  return items.map((item) =>
    item.id === id
      ? {
          ...item,
          status: "completed" as const,
          post_id: postId ?? item.post_id,
          error: null,
        }
      : item,
  );
}

export function markDispatchFailed(
  items: ScheduleItem[],
  id: string,
  error: string,
  postId?: string,
): ScheduleItem[] {
  return items.map((item) =>
    item.id === id
      ? {
          ...item,
          status: "failed" as const,
          error,
          post_id: postId ?? item.post_id,
        }
      : item,
  );
}

/**
 * Recover rows stuck in `publishing` (e.g. the app closed or reloaded
 * mid-dispatch and the persisted row never settled). Every in-flight row
 * found in storage is by definition stale, so each one returns to
 * `queued` with an explanatory error — actionable immediately via the
 * row's Post now action. All other statuses pass through untouched and
 * the input array is never mutated.
 */
export function recoverStuckPublishing(
  items: ScheduleItem[],
): ScheduleItem[] {
  return items.map((item) =>
    item.status === "publishing"
      ? {
          ...item,
          status: "queued" as const,
          error:
            "Publish was interrupted before it finished — post again when ready.",
        }
      : item,
  );
}

/**
 * Remove one entry from the schedule queue by id. Works for every status
 * (queued / publishing / completed / failed); unknown ids leave the
 * queue untouched. The video file on disk is never affected.
 */
export function removeQueueItem(
  items: ScheduleItem[],
  id: string,
): ScheduleItem[] {
  return items.filter((item) => item.id !== id);
}

/** Millis for a queue release slot; unparseable dates sort last. */
export function queueTimeOf(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Queue entries oldest release first. Invalid dates sort last; the input
 * array is never mutated.
 */
export function sortQueueBySchedule<
  T extends Pick<ScheduleItem, "scheduled_for">,
>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => queueTimeOf(a.scheduled_for) - queueTimeOf(b.scheduled_for),
  );
}

/** Status filter for the queue list: every status, or one row status. */
export type QueueStatusFilter = "all" | ScheduleItem["status"];

export interface QueueFilterOptions {
  status?: QueueStatusFilter;
  query?: string;
}

/**
 * First queue entry for a video file, matched on the trimmed path.
 * Undefined for blank input or no match. Powers the duplicate guard so
 * the QuickSchedule card and Social scheduling never queue one file twice.
 */
export function findQueueItemByVideoPath(
  items: ScheduleItem[],
  videoPath: string,
): ScheduleItem | undefined {
  const wanted = (videoPath ?? "").trim();
  if (!wanted) return undefined;
  return items.find((item) => (item.video_path ?? "").trim() === wanted);
}

/** True when a video file already has a queue entry. */
export function isVideoPathQueued(
  items: Pick<ScheduleItem, "video_path">[],
  videoPath: string,
): boolean {
  const wanted = (videoPath ?? "").trim();
  if (!wanted) return false;
  return items.some((item) => (item.video_path ?? "").trim() === wanted);
}

/**
 * Drop every `completed` entry. All other statuses pass through in order;
 * the input array is never mutated.
 */
export function clearCompletedItems(items: ScheduleItem[]): ScheduleItem[] {
  return items.filter((item) => item.status !== "completed");
}

/**
 * Queue hygiene filter: status first, then a case-insensitive
 * title-or-path search. Input order is preserved (callers sort for
 * display); the input array is never mutated.
 */
export function filterQueueItems(
  items: ScheduleItem[],
  options: QueueFilterOptions = {},
): ScheduleItem[] {
  const status = options.status ?? "all";
  const query = (options.query ?? "").trim().toLowerCase();
  return items.filter((item) => {
    if (status !== "all" && item.status !== status) return false;
    if (!query) return true;
    return (
      item.title.toLowerCase().includes(query) ||
      item.video_path.toLowerCase().includes(query)
    );
  });
}

/**
 * True when a queued entry's release slot is in the past. Only `queued`
 * entries can be overdue; other statuses and unparseable dates never are.
 */
export function isQueueItemOverdue(
  item: Pick<ScheduleItem, "status" | "scheduled_for">,
  now: number = Date.now(),
): boolean {
  if (item.status !== "queued") return false;
  const t = new Date(item.scheduled_for).getTime();
  return !Number.isNaN(t) && t < now;
}
