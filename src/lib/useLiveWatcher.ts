import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { probeStream, type SuggestStreamClipsOptions } from "./streamClips";
import {
  LIVE_WATCH_INTERVAL_MS,
  isLiveVodReady,
  liveUrlsDueForCheck,
  recordLiveCheck,
  watchableLiveUrls,
  type StreamRun,
  type StreamRunStore,
} from "./streamRuns";

/**
 * App-owned live watcher: re-probes watch-for-VOD runs until the replay
 * lands, then starts clip finding. Survives Studio unmount / tab switches.
 */
export function useLiveWatcher(
  runs: StreamRunStore,
  setRuns: Dispatch<SetStateAction<StreamRunStore>>,
  isRunning: (url: string) => boolean,
  startAnalysis: (url: string, options: SuggestStreamClipsOptions, layout: string) => void,
  getOptions: (run: StreamRun) => SuggestStreamClipsOptions,
) {
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  const startRef = useRef(startAnalysis);
  startRef.current = startAnalysis;
  const getOptionsRef = useRef(getOptions);
  getOptionsRef.current = getOptions;
  const inflight = useRef(new Set<string>());

  const watchKey = watchableLiveUrls(runs).join("\n");

  useEffect(() => {
    const urls = watchKey.split("\n").filter(Boolean);
    if (!urls.length) return;
    let disposed = false;

    async function check(url: string) {
      if (disposed || isRunningRef.current(url) || inflight.current.has(url)) return;
      inflight.current.add(url);
      try {
        const probe = await probeStream(url);
        if (disposed) return;
        setRuns((prev) => recordLiveCheck(prev, url, probe));
        if (!isLiveVodReady(probe) || isRunningRef.current(url)) return;
        const run = runsRef.current.runs[url];
        if (!run) return;
        void startRef.current(url, getOptionsRef.current(run), run.layout);
      } catch {
        if (disposed) return;
        setRuns((prev) => {
          const run = prev.runs[url];
          if (!run) return prev;
          const now = new Date().toISOString();
          return {
            ...prev,
            runs: { ...prev.runs, [url]: { ...run, lastCheckedAt: now, updatedAt: now } },
          };
        });
      } finally {
        inflight.current.delete(url);
      }
    }

    function tick() {
      const due = liveUrlsDueForCheck(runsRef.current);
      for (const url of due) void check(url);
    }

    tick();
    const timer = window.setInterval(tick, LIVE_WATCH_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [watchKey, setRuns]);
}
