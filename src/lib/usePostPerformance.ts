import { useCallback, useEffect, useRef, useState } from "react";
import type { ScheduleItem } from "../types/index.ts";
import { getPostAnalytics } from "./ipc.ts";
import {
  applyMetrics,
  loadPerformance,
  needsRefresh,
  parseAnalytics,
  savePerformance,
  trackPublished,
  type PerformanceRecords,
} from "./performance.ts";

/** Gateway calls per refresh pass; the rest wait for the next pass. */
const MAX_FETCHES_PER_PASS = 20;

/**
 * App-owned post performance: tracks every published queue row, refreshes
 * stale metrics from Zernio on mount and on demand, and persists records
 * so the history outlives a cleared queue.
 */
export function usePostPerformance(queue: ScheduleItem[], zernioKey: string) {
  const [records, setRecords] = useState<PerformanceRecords>(() =>
    loadPerformance(),
  );
  const [refreshing, setRefreshing] = useState(false);
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const runningRef = useRef(false);

  useEffect(() => {
    setRecords((prev) => trackPublished(prev, queue));
  }, [queue]);

  useEffect(() => {
    savePerformance(records);
  }, [records]);

  const refresh = useCallback(
    async (force = false) => {
      const key = zernioKey.trim();
      if (!key || runningRef.current) return;
      runningRef.current = true;
      setRefreshing(true);
      try {
        const now = new Date();
        const due = Object.values(recordsRef.current)
          .filter((r) => force || needsRefresh(r, now))
          .slice(0, MAX_FETCHES_PER_PASS);
        // Sequential on purpose: gentle on the gateway's rate limits.
        for (const record of due) {
          try {
            const text = await getPostAnalytics(key, record.postId);
            const result = parseAnalytics(text);
            setRecords((prev) =>
              applyMetrics(
                prev,
                record.postId,
                result,
                new Date(),
                result ? null : "No analytics in the gateway response",
              ),
            );
          } catch (err) {
            setRecords((prev) =>
              applyMetrics(
                prev,
                record.postId,
                null,
                new Date(),
                err instanceof Error ? err.message : "Analytics request failed",
              ),
            );
          }
        }
      } finally {
        runningRef.current = false;
        setRefreshing(false);
      }
    },
    [zernioKey],
  );

  // One background pass per session (and when the key changes).
  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  return { records, refreshing, refresh };
}
