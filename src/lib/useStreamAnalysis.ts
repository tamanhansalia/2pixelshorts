import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { applyClipProgress, clipFailureText, createStreamAnalysisRunner, isBusyClipJob, type StreamAnalysisJobs } from "./streamAnalysis";
import { listenClipProgress, parseStreamLength, probeStream, suggestStreamClips } from "./streamClips";
import { notify } from "./notify";
import {
  armWatchLive,
  blankStreamRun,
  upsertStreamRun,
  watchableLiveUrls,
  type StreamRunStore,
} from "./streamRuns";

/** Keep clip requests and their results alive when Studio unmounts. */
export function useStreamAnalysis(
  setRuns: Dispatch<SetStateAction<StreamRunStore>>,
  runs: StreamRunStore,
) {
  const [jobs, setJobs] = useState<StreamAnalysisJobs>({});
  const watchingAnnounced = useRef(new Set<string>());
  const [runner] = useState(() => createStreamAnalysisRunner({
    probe: probeStream,
    suggest: suggestStreamClips,
    onStart(job, options, layout) {
      watchingAnnounced.current.delete(job.url);
      setJobs((prev) => ({ ...prev, [job.url]: job }));
      setRuns((prev) => upsertStreamRun(prev, {
        ...(prev.runs[job.url] ?? blankStreamRun(job.url)),
        result: null, selected: [], agent: options.agentId || "auto", layout,
        workflow: "review", length: parseStreamLength(options.length), updatedAt: job.startedAt,
      }));
    },
    onProbe(url, probe) {
      setRuns((prev) => {
        const run = prev.runs[url];
        if (!run) return prev;
        return {
          ...prev,
          runs: {
            ...prev.runs,
            [url]: {
              ...run,
              probe,
              lastCheckedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
        };
      });
    },
    onWatching(job) {
      setJobs((prev) => ({ ...prev, [job.url]: job }));
      setRuns((prev) => armWatchLive(prev, job.url));
      if (!watchingAnnounced.current.has(job.url)) {
        watchingAnnounced.current.add(job.url);
        notify("Stream is live", "Clip finding starts when the replay is ready.", "info");
      }
    },
    onComplete(job, result) {
      watchingAnnounced.current.delete(job.url);
      setRuns((prev) => upsertStreamRun(prev, {
        ...(prev.runs[job.url] ?? blankStreamRun(job.url)), result, watchLive: false,
        selected: result.clips.map((_, index) => index), updatedAt: new Date().toISOString(),
      }));
      setJobs((prev) => ({ ...prev, [job.url]: job }));
      const count = result.clips.length;
      notify(count ? "Clips ready" : "No clips found",
        count ? `${count} clip${count === 1 ? "" : "s"} from ${result.title || job.url} — open the stream in the sidebar.`
          : "No moments cleared the selection criteria. Open the stream to try again.", count ? "success" : "info");
    },
    onFailure(job) {
      watchingAnnounced.current.delete(job.url);
      setJobs((prev) => ({ ...prev, [job.url]: job }));
      if (job.status === "failed") notify("Clip finding failed", clipFailureText(job.error), "error");
    },
  }));

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listenClipProgress((event) => {
      setJobs((prev) => applyClipProgress(prev, event.url, event.line));
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // App reload: persisted watch-for-VOD runs have no in-memory job.
  const watchKey = watchableLiveUrls(runs).join("\n");
  useEffect(() => {
    const urls = watchKey.split("\n").filter(Boolean);
    if (!urls.length) return;
    setJobs((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const url of urls) {
        if (isBusyClipJob(next[url])) continue;
        next[url] = { url, startedAt: new Date().toISOString(), status: "watching" };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [watchKey]);

  function dismissJob(url: string) {
    if (runner.isRunning(url)) return;
    setJobs((prev) => {
      const next = { ...prev };
      delete next[url];
      return next;
    });
  }

  function stopWatching(url: string) {
    if (runner.isRunning(url)) return;
    setRuns((prev) => {
      const run = prev.runs[url];
      if (!run?.watchLive) return prev;
      return {
        ...prev,
        runs: { ...prev.runs, [url]: { ...run, watchLive: false, updatedAt: new Date().toISOString() } },
      };
    });
    setJobs((prev) => {
      if (prev[url]?.status !== "watching") return prev;
      const next = { ...prev };
      delete next[url];
      return next;
    });
    watchingAnnounced.current.delete(url);
  }

  return { jobs, startAnalysis: runner.start, isRunning: runner.isRunning, dismissJob, stopWatching };
}
