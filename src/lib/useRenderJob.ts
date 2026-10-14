import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelJob,
  getJobStatus,
  isTerminalJobStatus,
  listenRenderFinished,
  listenRenderProgress,
  startRenderJob,
} from "./jobs.ts";
import type {
  CommandOutput,
  JobStatus,
  RenderJobProgress,
  RenderShortParams,
} from "../types/index.ts";

const MAX_LOG_LINES = 200;

export interface RenderJobState {
  jobId: string | null;
  status: JobStatus | "idle";
  progress: number;
  stage: string;
  logLines: string[];
  result: CommandOutput | null;
  error: string | null;
  isRunning: boolean;
  start: (params: RenderShortParams) => Promise<string>;
  cancel: () => Promise<void>;
  reset: () => void;
  /** Adopt an already-running job (e.g. started before a tab switch). */
  attach: (jobId: string) => Promise<void>;
}

const IDLE_STATE = {
  jobId: null as string | null,
  status: "idle" as JobStatus | "idle",
  progress: 0,
  stage: "",
  logLines: [] as string[],
  result: null as CommandOutput | null,
  error: null as string | null,
};

/**
 * Drives one background render job: subscribes to Tauri progress/finished
 * events (or the browser simulation), exposes determinate progress plus a
 * capped live log, and supports cancellation.
 */
export function useRenderJob(onFinished?: (s: {
  status: JobStatus;
  result: CommandOutput | null;
  error: string | null;
}) => void): RenderJobState {
  const [state, setState] = useState(IDLE_STATE);
  const jobIdRef = useRef<string | null>(null);
  const onFinishedRef = useRef(onFinished);
  const finishedHandlerRef = useRef<((info: {
    id: string; status: JobStatus; result: CommandOutput | null;
    error: string | null; progress: number; stage: string;
  }) => void) | null>(null);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    let disposed = false;

    const handleProgress = (p: RenderJobProgress) => {
      if (disposed || p.job_id !== jobIdRef.current) return;
      setState((prev) => {
        if (prev.status !== "queued" && prev.status !== "running") return prev;
        const logLines = [...prev.logLines, p.line].slice(-MAX_LOG_LINES);
        return { ...prev, status: "running", progress: p.progress, stage: p.stage, logLines };
      });
    };

    const handleFinished = (info: {
      id: string;
      status: JobStatus;
      result: CommandOutput | null;
      error: string | null;
      progress: number;
      stage: string;
    }) => {
      if (disposed || info.id !== jobIdRef.current) return;
      jobIdRef.current = null;
      setState((prev) => ({
        ...prev,
        status: info.status,
        progress: info.status === "completed" ? 1 : prev.progress,
        result: info.result,
        error: info.error,
      }));
      onFinishedRef.current?.({
        status: info.status,
        result: info.result,
        error: info.error,
      });
    };

    finishedHandlerRef.current = handleFinished;
    let unlistenProgress: (() => void) | null = null;
    let unlistenFinished: (() => void) | null = null;
    listenRenderProgress(handleProgress).then((fn) => {
      if (disposed) fn();
      else unlistenProgress = fn;
    });
    listenRenderFinished(handleFinished).then((fn) => {
      if (disposed) fn();
      else unlistenFinished = fn;
    });

    return () => {
      disposed = true;
      if (finishedHandlerRef.current === handleFinished) finishedHandlerRef.current = null;
      unlistenProgress?.();
      unlistenFinished?.();
    };
  }, []);

  const start = useCallback(async (params: RenderShortParams) => {
    // Cancel any previous run before starting a new one.
    if (jobIdRef.current) {
      try {
        await cancelJob(jobIdRef.current);
      } catch {
        // Previous job already gone; continue with the new one.
      }
    }
    const id = await startRenderJob(params);
    jobIdRef.current = id;
    setState({
      ...IDLE_STATE,
      jobId: id,
      status: "queued",
      stage: "Queued",
      logLines: [],
    });
    // Reconcile a terminal event that raced the start-job IPC reply.
    void getJobStatus(id).then((info) => {
      if (isTerminalJobStatus(info.status)) finishedHandlerRef.current?.(info);
    }).catch(() => {});
    return id;
  }, []);

  const attach = useCallback(async (jobId: string) => {
    if (jobIdRef.current === jobId) return;
    jobIdRef.current = jobId;
    try {
      const info = await getJobStatus(jobId);
      setState((prev) => ({
        ...prev,
        jobId,
        status: info.status,
        progress: info.progress,
        stage: info.stage,
        result: info.result,
        error: info.error,
        // A re-attached view missed the earlier stream; start the visible
        // log from the current stage instead of showing a stale one.
        logLines: prev.jobId === jobId ? prev.logLines : [info.stage].filter(Boolean),
      }));
    } catch {
      jobIdRef.current = null;
    }
  }, []);

  const cancel = useCallback(async () => {
    const id = jobIdRef.current;
    if (!id) return;
    await cancelJob(id);
  }, []);

  const reset = useCallback(() => {
    jobIdRef.current = null;
    setState(IDLE_STATE);
  }, []);

  const isRunning = state.status === "queued" || state.status === "running";

  return { ...state, isRunning, start, cancel, reset, attach };
}

export { isTerminalJobStatus };
