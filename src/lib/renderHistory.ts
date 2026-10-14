import type {
  JobStatus,
  RenderJobInfo,
  RenderJobProgress,
  RenderShortParams,
} from "../types/index.ts";

/**
 * Render-job history: every started render is recorded here so progress
 * stays visible when the user leaves the Studio tab, and past renders
 * remain reviewable after they finish.
 *
 * Entries are plain data (persisted to localStorage, capped) updated from
 * the same `render-progress` / `render-finished` events that drive the
 * live Studio view. Progress is 0–1, matching `RenderJobInfo`.
 */

export interface RenderHistorySeo {
  title: string;
  description: string;
  tags: string[];
}

export interface RenderHistoryEntry {
  id: string;
  inputVideo: string;
  outputVideo: string;
  presetId: string;
  agentId?: string;
  /** Meta-page SEO captured when the render started; queued with the output. */
  seo?: RenderHistorySeo;
  status: JobStatus;
  progress: number;
  stage: string;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

export const RENDER_HISTORY_KEY = "2pixel_render_history";
export const MAX_RENDER_HISTORY = 20;

export function isActiveRenderStatus(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}

export function activeRenderJobs(jobs: RenderHistoryEntry[]): RenderHistoryEntry[] {
  return jobs.filter((j) => isActiveRenderStatus(j.status));
}

/**
 * Dismiss a "Ready to queue" output: drop every finished entry for the
 * path so the row disappears. Active renders are never removed, and the
 * video file itself is untouched (it can be re-queued via Add a video).
 */
export function dismissOutputFromHistory(
  jobs: RenderHistoryEntry[],
  outputPath: string,
): RenderHistoryEntry[] {
  return jobs.filter(
    (j) => j.outputVideo !== outputPath || isActiveRenderStatus(j.status),
  );
}

export function createRenderHistoryEntry(
  id: string,
  params: Pick<RenderShortParams, "input_video" | "output_video" | "preset_id" | "agent_id">,
  seo?: RenderHistorySeo,
): RenderHistoryEntry {
  return {
    id,
    inputVideo: params.input_video,
    outputVideo: params.output_video,
    presetId: params.preset_id,
    agentId: params.agent_id,
    seo,
    status: "queued",
    progress: 0,
    stage: "Queued",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
}

/** Insert a new entry first; drop oldest finished entries past the cap. Active jobs are never dropped. */
export function pushHistoryEntry(
  jobs: RenderHistoryEntry[],
  entry: RenderHistoryEntry,
): RenderHistoryEntry[] {
  const next = [entry, ...jobs.filter((j) => j.id !== entry.id)];
  const active = next.filter((j) => isActiveRenderStatus(j.status));
  const finished = next.filter((j) => !isActiveRenderStatus(j.status));
  return [...active, ...finished].slice(0, MAX_RENDER_HISTORY);
}

/** Fold a progress event into the matching entry. Unknown ids are ignored. */
export function applyProgressToHistory(
  jobs: RenderHistoryEntry[],
  p: Pick<RenderJobProgress, "job_id" | "progress" | "stage">,
): RenderHistoryEntry[] {
  let changed = false;
  const next = jobs.map((j) => {
    if (j.id !== p.job_id || !isActiveRenderStatus(j.status)) return j;
    changed = true;
    return {
      ...j,
      status: "running" as JobStatus,
      progress: Math.min(1, Math.max(0, p.progress)),
      stage: p.stage || j.stage,
    };
  });
  return changed ? next : jobs;
}

/** Fold a finished event into the matching entry. Unknown ids are ignored. */
export function applyFinishedToHistory(
  jobs: RenderHistoryEntry[],
  info: Pick<RenderJobInfo, "id" | "status" | "result" | "error" | "progress" | "stage" | "finished_at">,
): RenderHistoryEntry[] {
  let changed = false;
  const next = jobs.map((j) => {
    if (j.id !== info.id) return j;
    changed = true;
    return {
      ...j,
      status: info.status,
      progress:
        info.status === "completed"
          ? 1
          : Math.min(1, Math.max(0, info.progress)),
      stage: info.stage || j.stage,
      finishedAt: info.finished_at ?? new Date().toISOString(),
      error: info.error,
    };
  });
  return changed ? next : jobs;
}

export function loadRenderHistory(): RenderHistoryEntry[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(RENDER_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RenderHistoryEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as { id?: unknown }).id === "string",
    );
  } catch {
    return [];
  }
}

export function saveRenderHistory(jobs: RenderHistoryEntry[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      RENDER_HISTORY_KEY,
      JSON.stringify(jobs.slice(0, MAX_RENDER_HISTORY)),
    );
  } catch {
    // Storage full or unavailable: history is best-effort.
  }
}
