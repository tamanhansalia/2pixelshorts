import { notify } from "../../lib/notify";
import React from "react";
import {
  AlertCircle,
  CheckCircle2,
  Film,
  FolderOpen,
  Play,
  Plus,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { JobStatus } from "../../types";
import { isActiveRenderStatus, type RenderHistoryEntry } from "../../lib/renderHistory";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { LinearProgress } from "../ui/LinearProgress";

const STATUS_BADGE: Record<JobStatus, { variant: "accent" | "success" | "danger" | "neutral"; label: string }> = {
  queued: { variant: "neutral", label: "Queued" },
  running: { variant: "accent", label: "Rendering" },
  completed: { variant: "success", label: "Completed" },
  failed: { variant: "danger", label: "Failed" },
  cancelled: { variant: "neutral", label: "Cancelled" },
};

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

interface RenderJobsPanelProps {
  jobs: RenderHistoryEntry[];
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onClearFinished: () => void;
  onOpenFileLocation: (path: string) => void;
  onOpenFile: (path: string) => void;
  onQueueOutput?: (outputPath: string) => void;
  compact?: boolean;
}

export const RenderJobsPanel: React.FC<RenderJobsPanelProps> = ({
  jobs,
  onCancel,
  onDismiss,
  onClearFinished,
  onOpenFileLocation,
  onOpenFile,
  onQueueOutput,
  compact = false,
}) => {
  const active = jobs.filter((j) => isActiveRenderStatus(j.status));
  const finished = jobs.filter((j) => !isActiveRenderStatus(j.status));

  if (jobs.length === 0) {
    return (
      <EmptyState
        compact={compact}
        icon={<Film />}
        title="No renders yet"
        description="Renders started in Studio are tracked here, even when you switch tabs."
      />
    );
  }

  const renderRow = (job: RenderHistoryEntry) => {
    const badge = STATUS_BADGE[job.status];
    const running = isActiveRenderStatus(job.status);
    const pct = Math.round(job.progress * 100);
    return (
      <div key={job.id} className="space-y-2 px-3 py-2.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground" title={job.outputVideo}>
              {fileNameOf(job.outputVideo)}
            </div>
            <div className="truncate font-mono text-xs text-muted" title={job.inputVideo}>
              {fileNameOf(job.inputVideo)} · {job.presetId}
              {job.agentId ? ` · ${job.agentId}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={badge.variant} dot={running}>
              {running ? `${badge.label} · ${pct}%` : badge.label}
            </Badge>
            {running ? (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Square />}
                onClick={() => onCancel(job.id)}
                aria-label={`Cancel render ${fileNameOf(job.outputVideo)}`}
                title="Cancel render"
              />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<X />}
                onClick={() => onDismiss(job.id)}
                aria-label={`Dismiss render ${fileNameOf(job.outputVideo)}`}
                title="Dismiss from history"
              />
            )}
          </div>
        </div>

        {running ? (
          <div className="space-y-1.5">
            <div className="truncate font-mono text-xs text-muted" title={job.stage}>
              {job.stage || "Starting…"}
            </div>
            <LinearProgress progress={pct} label={`Render progress: ${pct}%`} />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {job.status === "completed" ? (
              <>
                <CheckCircle2 className="size-3.5 text-success" />
                <span className="tabular-nums text-xs text-muted">
                  {job.finishedAt ? new Date(job.finishedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "done"}
                </span>
                <span className="flex-1" />
                <Button variant="ghost" size="sm" iconOnly icon={<FolderOpen />} onClick={() => onOpenFileLocation(job.outputVideo)} aria-label="Show in folder" title="Show in folder" className="size-7" />
                <Button variant="ghost" size="sm" iconOnly icon={<Play />} onClick={() => onOpenFile(job.outputVideo)} aria-label="Play" title="Play" className="size-7" />
                {onQueueOutput && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="ml-1 h-7"
                    icon={<Plus />}
                    onClick={() => onQueueOutput(job.outputVideo)}
                    aria-label={`Queue ${fileNameOf(job.outputVideo)} for posting`}
                    title="Queue this short for posting"
                  >
                    Queue
                  </Button>
                )}
              </>
            ) : (
              <>
                <AlertCircle className={`size-3.5 ${job.status === "cancelled" ? "text-muted" : "text-danger"}`} />
                <span className="line-clamp-2 text-xs text-muted">
                  <button type="button" className="underline" onClick={() => notify(job.status === "cancelled" ? "Render cancelled" : "Render failed", job.error || "No further details available.", job.status === "cancelled" ? "info" : "error")}>View details</button>
                </span>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {active.length > 0 && (
        <div className="space-y-1.5">
          {!compact && (
            <div className="text-xs font-medium tracking-wide text-muted uppercase">
              Active · {active.length}
            </div>
          )}
          <div className="divide-y divide-separator overflow-hidden rounded-md border border-border">
            {active.map(renderRow)}
          </div>
        </div>
      )}
      {finished.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium tracking-wide text-muted uppercase">
              History · {finished.length}
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 />}
              onClick={onClearFinished}
              aria-label="Clear finished renders"
            >
              Clear finished
            </Button>
          </div>
          <div className="divide-y divide-separator overflow-hidden rounded-md border border-border">
            {(compact ? finished.slice(0, 3) : finished).map(renderRow)}
          </div>
        </div>
      )}
    </div>
  );
};
