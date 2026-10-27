import { isLiveStreamError, type StreamProbe, type SuggestStreamClipsOptions, type SuggestStreamClipsResult } from "./streamClips.ts";

export type StreamAnalysisJob = {
  url: string;
  startedAt: string;
} & (
  | { status: "running"; detail?: string }
  | { status: "watching" }
  | { status: "completed"; finishedAt: string; clipCount: number }
  | { status: "failed"; finishedAt: string; error: string }
);

/** What the clip finder should say while a helper line arrives.
 *
 * A replay with no captions falls through to a full-audio listen. Those
 * lines are the only signal that the wait is transcription, not a search
 * that has already failed. */
export function clipRunDetail(line: string): string | null {
  const processed = line.match(/\[TRANSCRIBE\] Processed (\d+)\/(\d+)s/);
  if (processed) {
    const done = Number(processed[1]);
    const total = Number(processed[2]);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
      return `No captions on this replay. Transcribing the full replay · ${formatListenMinutes(done)} of ${formatListenMinutes(total)}.`;
    }
  }
  if (/captions unavailable|transcribing source audio/i.test(line)) {
    return "No captions on this replay. Transcribing the full replay.";
  }
  return null;
}

function formatListenMinutes(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  return minutes === 1 ? "1 min" : `${minutes} min`;
}

/** The helper prefixes its own errors. The card shows the sentence. */
export function clipFailureText(error: string): string {
  const text = error.replace(/^stream_clip\.py:\s*/i, "").replace(/\s+/g, " ").trim();
  return text || "Clip finding failed.";
}

export function applyClipProgress(
  jobs: StreamAnalysisJobs,
  url: string,
  line: string,
): StreamAnalysisJobs {
  const job = jobs[url];
  if (!job || job.status !== "running") return jobs;
  const detail = clipRunDetail(line);
  if (!detail || job.detail === detail) return jobs;
  return { ...jobs, [url]: { ...job, detail } };
}

export type StreamAnalysisJobs = Record<string, StreamAnalysisJob>;

export function isBusyClipJob(job?: StreamAnalysisJob | null): boolean {
  return job?.status === "running" || job?.status === "watching";
}

interface Dependencies {
  probe: (url: string) => Promise<StreamProbe>;
  suggest: (url: string, options: SuggestStreamClipsOptions) => Promise<SuggestStreamClipsResult>;
  onStart: (job: StreamAnalysisJob, options: SuggestStreamClipsOptions, layout: string) => void;
  onProbe: (url: string, probe: StreamProbe) => void;
  onWatching: (job: StreamAnalysisJob) => void;
  onComplete: (job: StreamAnalysisJob, result: SuggestStreamClipsResult) => void;
  onFailure: (job: StreamAnalysisJob) => void;
}

/** Owned by App, with no page lifecycle or currently selected source dependency. */
export function createStreamAnalysisRunner(deps: Dependencies) {
  const pending = new Map<string, Promise<void>>();

  function start(rawUrl: string, options: SuggestStreamClipsOptions, layout = "auto"): Promise<void> {
    const url = rawUrl.trim();
    const existing = pending.get(url);
    if (existing) return existing;
    const job = { url, startedAt: new Date().toISOString() };
    // Defer execution until the lock is registered, including rapid repeat clicks.
    const operation = Promise.resolve().then(async () => {
      deps.onStart({ ...job, status: "running" }, options, layout);
      // Metadata is decorative: it must never delay completion or hide a failure.
      void Promise.resolve().then(() => deps.probe(url)).then((probe) => {
        if (pending.get(url) !== operation) return;
        deps.onProbe(url, probe);
        if (probe.is_live) deps.onWatching({ ...job, status: "watching" });
      }).catch(() => {});
      try {
        const result = await deps.suggest(url, options);
        deps.onComplete({
          ...job, status: "completed", finishedAt: new Date().toISOString(), clipCount: result.clips.length,
        }, result);
      } catch (error) {
        if (isLiveStreamError(error)) {
          deps.onWatching({ ...job, status: "watching" });
        } else {
          deps.onFailure({
            ...job, status: "failed", finishedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : typeof error === "string" ? error : "Could not analyze stream",
          });
        }
      } finally {
        pending.delete(url);
      }
    });
    pending.set(url, operation);
    return operation;
  }

  return { start, isRunning: (url: string) => pending.has(url.trim()) };
}
