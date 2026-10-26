import type {
  StreamProbe,
  SuggestStreamClipsResult,
} from "./streamClips.ts";

/**
 * Persistent stream runs (BridgeClip-Library style): every analyzed link
 * keeps its video card, clips, and selection in localStorage, keyed by
 * URL. App owns active clip requests separately; their completions merge
 * into this store even while Studio is unmounted.
 */

export interface StreamRun {
  /** Normalized URL: trimmed, the stable identity of a run. */
  url: string;
  probe: StreamProbe | null;
  result: SuggestStreamClipsResult | null;
  /** Indexes into result.clips that are selected for queuing. */
  selected: number[];
  agent: string;
  workflow: string;
  length: string;
  /** Short framing (auto | single | screen-top | face-top | face-only). */
  layout: string;
  /** Always "auto": the engine detects the facecam itself. Kept so
   * runs stored before the manual picker was removed still load. */
  faceRoi: string;
  /** Watch-for-VOD: re-probe this live link until the VOD lands. */
  watchLive: boolean;
  /** Last background re-probe time, so the UI can show staleness. */
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StreamRunStore {
  runs: Record<string, StreamRun>;
  /** Most-recently-touched URLs first. */
  recent: string[];
}

export const STREAM_RUNS_KEY = "2pixel_stream_runs";
export const MAX_STREAM_RUNS = 20;

export function normalizeStreamUrl(url: string): string {
  return (url || "").trim();
}

export function emptyStreamRunStore(): StreamRunStore {
  return { runs: {}, recent: [] };
}

export function blankStreamRun(url: string): StreamRun {
  const now = new Date().toISOString();
  return {
    url,
    probe: null,
    result: null,
    selected: [],
    agent: "claude",
    workflow: "review",
    length: "standard",
    layout: "auto",
    faceRoi: "auto",
    watchLive: false,
    lastCheckedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** How often App re-probes a live link while waiting for the VOD. */
export const LIVE_WATCH_INTERVAL_MS = 60_000;

/** A run the watcher should keep re-probing: flagged live, no clips yet. */
export function isWatchableLiveRun(run: StreamRun | null | undefined): boolean {
  return Boolean(run && run.watchLive && run.probe?.is_live && !run.result);
}

export function watchableLiveUrls(store: StreamRunStore): string[] {
  return store.recent.filter((url) => isWatchableLiveRun(store.runs[url]));
}

/** True when the replay has landed and clip finding can run. */
export function isLiveVodReady(probe: StreamProbe | null | undefined): boolean {
  return Boolean(probe && !probe.is_live && probe.duration > 0);
}

export function isLiveCheckDue(run: StreamRun, now = Date.now()): boolean {
  if (!isWatchableLiveRun(run)) return false;
  if (!run.lastCheckedAt) return true;
  const then = Date.parse(run.lastCheckedAt);
  if (!Number.isFinite(then)) return true;
  return now - then >= LIVE_WATCH_INTERVAL_MS;
}

export function liveUrlsDueForCheck(store: StreamRunStore, now = Date.now()): string[] {
  return watchableLiveUrls(store).filter((url) => isLiveCheckDue(store.runs[url], now));
}

/** Mark a run as watch-for-VOD after clip finding hits a live stream. */
export function armWatchLive(
  store: StreamRunStore,
  url: string,
  now = new Date().toISOString(),
): StreamRunStore {
  const run = getStreamRun(store, url) ?? blankStreamRun(url);
  return upsertStreamRun(store, {
    ...run,
    watchLive: true,
    lastCheckedAt: run.lastCheckedAt ?? now,
    updatedAt: now,
  });
}

export function clearWatchLive(
  store: StreamRunStore,
  url: string,
  now = new Date().toISOString(),
): StreamRunStore {
  const run = getStreamRun(store, url);
  if (!run?.watchLive) return store;
  return {
    ...store,
    runs: {
      ...store.runs,
      [run.url]: { ...run, watchLive: false, updatedAt: now },
    },
  };
}

/** Apply a watcher re-probe. VOD-ready probes drop the watch flag so
 * clip finding can start; still-live probes keep watching. */
export function recordLiveCheck(
  store: StreamRunStore,
  url: string,
  probe: StreamProbe,
  now = new Date().toISOString(),
): StreamRunStore {
  const run = getStreamRun(store, url);
  if (!run) return store;
  return {
    ...store,
    runs: {
      ...store.runs,
      [run.url]: {
        ...run,
        probe,
        lastCheckedAt: now,
        watchLive: probe.is_live ? run.watchLive : false,
        updatedAt: now,
      },
    },
  };
}

/** Insert or replace a run and move its URL to the front of recents. */
export function upsertStreamRun(
  store: StreamRunStore,
  run: StreamRun,
): StreamRunStore {
  const url = normalizeStreamUrl(run.url);
  if (!url) return store;
  const prev = store.runs[url];
  const createdAt = prev?.createdAt ?? run.createdAt ?? new Date().toISOString();
  const runs = { ...store.runs, [url]: { ...run, url, createdAt } };
  const recent = [url, ...store.recent.filter((u) => u !== url)].slice(
    0,
    MAX_STREAM_RUNS,
  );
  const keep = new Set(recent);
  for (const id of Object.keys(runs)) {
    if (!keep.has(id)) delete runs[id];
  }
  return { runs, recent };
}

export function getStreamRun(
  store: StreamRunStore,
  url: string,
): StreamRun | null {
  const clean = normalizeStreamUrl(url);
  return clean ? (store.runs[clean] ?? null) : null;
}

export function removeStreamRun(
  store: StreamRunStore,
  url: string,
): StreamRunStore {
  const clean = normalizeStreamUrl(url);
  if (!clean || !(clean in store.runs)) return store;
  const runs = { ...store.runs };
  delete runs[clean];
  return { runs, recent: store.recent.filter((u) => u !== clean) };
}

/** Most recent run worth reopening: analyzed runs first, then live
 * runs being watched (they have a probe card but no clips yet), else
 * the newest touched link, else null (fresh card). */
export function mostRecentUsableRun(store: StreamRunStore): StreamRun | null {
  for (const url of store.recent) {
    const run = store.runs[url];
    if (run && run.result) return run;
  }
  for (const url of store.recent) {
    const run = store.runs[url];
    if (isWatchableLiveRun(run)) return run;
  }
  const first = store.recent[0];
  return first ? (store.runs[first] ?? null) : null;
}

export interface StreamSidebarItem {
  url: string;
  title: string;
  clipCount: number | null;
  updatedAt: string;
  /** Live on last probe (shows the LIVE dot). */
  isLive: boolean;
  /** Watch-for-VOD armed with no clips yet. */
  watching: boolean;
}

/** Compact sidebar rows, most-recent first. */
export function streamSidebarItems(
  store: StreamRunStore,
  limit = 8,
): StreamSidebarItem[] {
  return store.recent.slice(0, limit).map((url) => {
    const run = store.runs[url];
    return {
      url,
      title: run?.probe?.title || run?.result?.title || url,
      clipCount: run?.result ? run.result.clips.length : null,
      updatedAt: run?.updatedAt ?? new Date(0).toISOString(),
      isLive: run?.probe?.is_live ?? false,
      watching: isWatchableLiveRun(run),
    };
  });
}

export function loadStreamRunStore(): StreamRunStore {
  try {
    if (typeof localStorage === "undefined") return emptyStreamRunStore();
    const raw = localStorage.getItem(STREAM_RUNS_KEY);
    if (!raw) return emptyStreamRunStore();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return emptyStreamRunStore();
    }
    const obj = parsed as Partial<StreamRunStore>;
    if (typeof obj.runs !== "object" || obj.runs === null) {
      return emptyStreamRunStore();
    }
    const recent = Array.isArray(obj.recent)
      ? obj.recent.filter((u): u is string => typeof u === "string")
      : [];
    const runs: Record<string, StreamRun> = {};
    for (const url of recent) {
      const run = (obj.runs as Record<string, unknown>)[url];
      if (typeof run === "object" && run !== null) {
        // Backfill runs stored before watch-for-VOD existed.
        runs[url] = {
          ...blankStreamRun(url),
          ...(run as Partial<StreamRun>),
          url,
        };
      }
    }
    return { runs, recent };
  } catch {
    return emptyStreamRunStore();
  }
}

export function saveStreamRunStore(store: StreamRunStore): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STREAM_RUNS_KEY, JSON.stringify(store));
  } catch {
    // Best-effort persistence.
  }
}
