import type { SeoMetadata } from "../types/index.ts";

/**
 * App-owned Studio SEO jobs. The fetch outlives the Studio view: switching
 * tabs unmounts VideoStudio mid-analysis, so the result must land in App
 * state (which never unmounts) instead of component state. Completion is
 * matched by requestId — a stale finish (re-click, video switch) never
 * overwrites newer work.
 */
export type StudioSeoJob =
  | {
      status: "running";
      requestId: number;
      targetVideo: string;
      startedAt: string;
    }
  | {
      status: "done";
      requestId: number;
      targetVideo: string;
      meta: SeoMetadata;
      finishedAt: string;
    }
  | {
      status: "error";
      requestId: number;
      targetVideo: string;
      message: string;
      finishedAt: string;
    };

export type StudioSeoJobs = Record<string, StudioSeoJob>;

export function startSeoJob(
  jobs: StudioSeoJobs,
  targetVideo: string,
  requestId: number,
  startedAt: string,
): StudioSeoJobs {
  return {
    ...jobs,
    [targetVideo]: { status: "running", requestId, targetVideo, startedAt },
  };
}

function liveEntry(
  jobs: StudioSeoJobs,
  targetVideo: string,
  requestId: number,
): boolean {
  const current = jobs[targetVideo];
  return (
    current?.status === "running" && current.requestId === requestId
  );
}

export function finishSeoJob(
  jobs: StudioSeoJobs,
  targetVideo: string,
  requestId: number,
  meta: SeoMetadata,
  finishedAt: string,
): StudioSeoJobs {
  if (!liveEntry(jobs, targetVideo, requestId)) return jobs;
  return {
    ...jobs,
    [targetVideo]: {
      status: "done",
      requestId,
      targetVideo,
      meta,
      finishedAt,
    },
  };
}

export function failSeoJob(
  jobs: StudioSeoJobs,
  targetVideo: string,
  requestId: number,
  message: string,
  finishedAt: string,
): StudioSeoJobs {
  if (!liveEntry(jobs, targetVideo, requestId)) return jobs;
  return {
    ...jobs,
    [targetVideo]: {
      status: "error",
      requestId,
      targetVideo,
      message,
      finishedAt,
    },
  };
}
