import { invoke } from "./invoke.ts";
import type { RenderHistoryEntry } from "./renderHistory.ts";
import { isActiveRenderStatus } from "./renderHistory.ts";
import { removeSource, slugifyTitle, type StudioStore } from "./studioProjects.ts";
import type { StreamRunStore } from "./streamRuns.ts";
import type { ScheduleItem } from "../types/index.ts";

/**
 * Settings > Storage: the native scanner lists only files the app made
 * (render sidecars, download markers, staged renders, caches, engine
 * backups). This module builds its scope from app records and keeps those
 * records consistent after a cleanup.
 */

export type StorageKind = "render" | "stream_clip" | "partial" | "analysis" | "cache" | "engine_backup";

export interface StorageItem {
  path: string;
  kind: StorageKind;
  bytes: number;
  files: string[];
  modified_ms: number | null;
  protected: boolean;
}

export interface StorageScope {
  directories: string[];
  recordPaths: string[];
  renderedVideos: string[];
  legacyStreamClips: string[];
  protected: string[];
}

export interface StorageDeleteReport {
  removed: string[];
  removed_files: string[];
  failed: { path: string; error: string }[];
  bytes: number;
}

export const STORAGE_CATEGORIES: { kind: StorageKind; label: string; description: string }[] = [
  { kind: "render", label: "Rendered shorts", description: "Exported MP4s with their caption and edit files." },
  { kind: "stream_clip", label: "Downloaded stream clips", description: "YouTube and Twitch clip windows fetched to edit." },
  { kind: "partial", label: "Unfinished renders", description: "Temporary files left when a render stopped part-way." },
  { kind: "analysis", label: "Leftover analysis files", description: "Caption, edit and framing files whose video was already deleted." },
  { kind: "cache", label: "Trends cache", description: "Saved keyword trend lookups. Refetched when needed." },
  { kind: "engine_backup", label: "Engine backups", description: "Old Python environments kept after engine upgrades. The app does not use them." },
];

/** Queue rows that may still be published keep their video. */
const PENDING_QUEUE = new Set<ScheduleItem["status"]>(["queued", "publishing", "failed"]);

function parentDir(path: string): string | null {
  const clean = (path || "").trim();
  const cut = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return !clean ? null : cut === 0 ? clean.slice(0, 1) : cut > 0 ? clean.slice(0, cut) : ".";
}

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(cut + 1);
}

/** Studio inputs named like a stream download from a known stream run. */
function legacyStreamClipPaths(studio: StudioStore, streamRuns: StreamRunStore): string[] {
  const prefixes = new Set(
    Object.values(streamRuns.runs)
      .map((run) => slugifyTitle(run.probe?.title || run.result?.title || ""))
      .filter(Boolean),
  );
  return Object.keys(studio.projects).filter((input) => {
    const match = /^(.+)_clip\d+\.mp4$/i.exec(baseName(input));
    return /^stream_src_\d+_\d+\.mp4$/i.test(baseName(input))
      || (match !== null && (prefixes.has(match[1]) || /^stream_src_\d+$/.test(match[1])));
  });
}

export function buildStorageScope(records: {
  history: RenderHistoryEntry[];
  studio: StudioStore;
  queue: ScheduleItem[];
  streamRuns: StreamRunStore;
}): StorageScope {
  const { history, studio, queue, streamRuns } = records;
  const paths = [
    ...history.flatMap((job) => [job.inputVideo, job.outputVideo]),
    ...Object.values(studio.projects).flatMap((draft) => [draft.inputPath, draft.outputPath]),
    ...queue.map((item) => item.video_path),
  ];
  const directories = [...new Set([".", ...paths.map(parentDir).filter((dir): dir is string => dir !== null)])];
  const inUse = [
    ...history.filter((job) => isActiveRenderStatus(job.status)).flatMap((job) => [job.inputVideo, job.outputVideo]),
    ...queue.filter((item) => PENDING_QUEUE.has(item.status)).map((item) => item.video_path),
  ];
  return {
    directories,
    recordPaths: [...new Set(paths.filter(Boolean))],
    renderedVideos: [...new Set(history.map((job) => job.outputVideo).filter(Boolean))],
    legacyStreamClips: legacyStreamClipPaths(studio, streamRuns),
    protected: [...new Set(inUse.filter(Boolean))],
  };
}

/** Drop records that point at deleted files: finished history rows and Studio sources. */
export function recordsAfterCleanup(
  history: RenderHistoryEntry[],
  studio: StudioStore,
  removedFiles: string[],
): { history: RenderHistoryEntry[]; studio: StudioStore; removedSources: string[] } {
  const removed = new Set(removedFiles);
  const nextHistory = history.filter((job) => isActiveRenderStatus(job.status) || !removed.has(job.outputVideo));
  const removedSources = Object.keys(studio.projects).filter((input) => removed.has(input));
  const nextStudio = removedSources.reduce(removeSource, studio);
  return {
    history: nextHistory.length === history.length ? history : nextHistory,
    studio: nextStudio,
    removedSources,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.max(1, Math.round(value)) : value.toFixed(1)} ${units[unit]}`;
}

export function scanStorage(scope: StorageScope): Promise<StorageItem[]> {
  return invoke<StorageItem[]>("scan_storage", { scope });
}

export function deleteStorageItems(scope: StorageScope, paths: string[]): Promise<StorageDeleteReport> {
  return invoke<StorageDeleteReport>("delete_storage_items", { scope, paths });
}
