import { useEffect, useState } from "react";
import { AlertCircle, ArrowUpRight, CheckCircle2, Sparkles, X } from "lucide-react";
import { Spinner } from "@heroui/react";
import { isBusyClipJob, type StreamAnalysisJob } from "../../lib/streamAnalysis";
import { formatClipTime } from "../../lib/streamClips";
import { LinearProgress } from "../ui/LinearProgress";

export type ClipActivityItem = StreamAnalysisJob & { title: string };

interface Props {
  jobs: ClipActivityItem[];
  onOpen?: (url: string) => void;
  onDismiss?: (url: string) => void;
}

export function ClipAnalysisActivity({ jobs, onOpen, onDismiss }: Props) {
  const [now, setNow] = useState(Date.now);
  const active = jobs.filter(isBusyClipJob);
  useEffect(() => {
    if (!active.length) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active.length]);
  if (!jobs.length) return null;

  const recent = jobs.filter((job) => job.status === "completed" || job.status === "failed")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 2);

  return (
    <section aria-label="Clip finder activity" className="mx-3 mb-2 shrink-0 rounded-xl border border-separator bg-surface p-3">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <Sparkles className="size-3.5 text-accent" />
        <span className="flex-1">Clip finder</span>
      </div>
      <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
        {[...active, ...recent].map((job) => (
          <div key={job.url} className="rounded-lg bg-surface-secondary p-2">
            <div className="flex items-start gap-1">
              <button type="button" onClick={() => onOpen?.(job.url)} title={job.title}
                className="flex min-w-0 flex-1 items-start gap-2 rounded text-left outline-offset-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
                <span className="mt-0.5 shrink-0">
                  {job.status === "running" || job.status === "watching" ? <Spinner size="sm" color="current" />
                    : job.status === "failed" ? <AlertCircle className="size-3.5 text-danger" />
                    : <CheckCircle2 className="size-3.5 text-success" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{job.title}</span>
                  {job.status === "watching" && <span className="mt-0.5 block text-xs text-muted">Waiting for the replay</span>}
                  {job.status !== "running" && job.status !== "watching" && <span className={`mt-0.5 block text-xs ${job.status === "failed" ? "text-danger" : "text-muted"}`}>
                    {job.status === "failed" ? "Failed · open to retry"
                      : job.clipCount ? `${job.clipCount} clip${job.clipCount === 1 ? "" : "s"} ready` : "No clips found"}
                  </span>}
                </span>
                {job.status === "running"
                  ? <span className="tabular-nums mt-0.5 text-xs text-muted">{formatClipTime(Math.max(0, (now - Date.parse(job.startedAt)) / 1000))}</span>
                  : <ArrowUpRight className="mt-0.5 size-3 shrink-0 text-muted" />}
              </button>
              {job.status !== "running" && onDismiss && (
                <button type="button" onClick={() => onDismiss(job.url)} aria-label={`Dismiss clip task for ${job.title}`}
                  className="rounded p-0.5 text-muted hover:bg-surface-tertiary hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">
                  <X className="size-3" />
                </button>
              )}
            </div>
            {job.status === "running" && <LinearProgress label={`Finding clips for ${job.title}`} className="mt-2" />}
          </div>
        ))}
      </div>
    </section>
  );
}
