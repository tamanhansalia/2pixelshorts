import { STUDIO_STORE_KEY } from "./studioProjects.ts";
import { RENDER_HISTORY_KEY } from "./renderHistory.ts";
import { STREAM_RUNS_KEY } from "./streamRuns.ts";
import {
  DEFAULT_KEY,
  LEGACY_CONTEXT_KEY,
  PROFILES_KEY,
  type KeyValueStorage,
} from "./channelProfiles.ts";

/**
 * Complete local reset: every key the app persists in this origin.
 * API credentials, queue, render history, studio drafts, channel
 * profiles, and sidebar UI state. Deliberately NOT included: the UI
 * theme preference (appearance, not data).
 */

export const API_KEY_ZERNIO = "2pixel_zernio_key";
export const API_KEY_ELEVENLABS = "2pixel_elevenlabs_key";
export const API_KEY_YOUTUBE = "2pixel_youtube_key";
export const SCHEDULE_QUEUE_KEY = "2pixel_schedule_queue";
export const SIDEBAR_GROUPS_KEY = "2pixel_sidebar_day_groups";

export const APP_STORAGE_KEYS: string[] = [
  API_KEY_ZERNIO,
  API_KEY_ELEVENLABS,
  API_KEY_YOUTUBE,
  SCHEDULE_QUEUE_KEY,
  RENDER_HISTORY_KEY,
  STUDIO_STORE_KEY,
  STREAM_RUNS_KEY,
  PROFILES_KEY,
  DEFAULT_KEY,
  LEGACY_CONTEXT_KEY,
  SIDEBAR_GROUPS_KEY,
];

/** Remove every app key from storage; returns the keys removed. Best-effort per key. */
export function resetAllLocalData(storage?: KeyValueStorage): string[] {
  const store =
    storage ??
    (typeof localStorage !== "undefined" ? localStorage : undefined);
  if (!store) return [];
  const removed: string[] = [];
  for (const key of new Set(APP_STORAGE_KEYS)) {
    try {
      store.removeItem(key);
      removed.push(key);
    } catch {
      // One locked key must not block the rest of the reset.
    }
  }
  return removed;
}
