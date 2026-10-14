/**
 * Ordering guard for slow async status probes (transcription engine checks).
 *
 * A probe started with an older key must never overwrite the result of a
 * newer probe: without this, a slow mount-time probe with the previous
 * (empty) key can resolve after the post-save probe and flip the Engine
 * page back to "Missing" even though the key was just saved.
 */
export interface LatestGuard {
  /** Claim a slot for a new request; returns its id. */
  next(): number;
  /** True only when no newer request has been claimed since `id`. */
  isLatest(id: number): boolean;
}

export function createLatestGuard(): LatestGuard {
  let latest = 0;
  return {
    next() {
      latest += 1;
      return latest;
    },
    isLatest(id: number) {
      return id === latest;
    },
  };
}

/**
 * True when the key typed in Settings differs from the saved key, i.e. the
 * Engine page (which reports on the saved key) is stale until Save.
 * Comparison is trim-insensitive so trailing whitespace is not "unsaved".
 */
export function isUnsavedEdit(draft: string, saved: string): boolean {
  return draft.trim() !== saved.trim();
}
