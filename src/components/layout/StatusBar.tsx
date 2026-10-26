import React from "react";
import { CalendarClock, Clapperboard, Sparkles, Terminal } from "lucide-react";
import { GlobalTaskStatus } from "../../types";
import { StatusDot } from "../ui/StatusDot";

interface StatusBarProps {
  desktop: boolean;
  globalTask: GlobalTaskStatus;
  cliAvailable: number;
  cliTotal: number;
  queueCount: number;
  activeRenderCount?: number;
  renderProgress?: number;
  onOpenJobs?: () => void;
  onOpenClis?: () => void;
  activeClipCount?: number;
  onOpenClips?: () => void;
}

const item =
  "flex h-full items-center gap-1.5 px-2.5 transition-colors hover:text-foreground";

export const StatusBar: React.FC<StatusBarProps> = ({
  desktop,
  globalTask,
  cliAvailable,
  cliTotal,
  queueCount,
  activeRenderCount = 0,
  renderProgress,
  onOpenJobs,
  onOpenClis,
  activeClipCount = 0,
  onOpenClips,
}) => {
  const isBusy = globalTask.type !== "idle";

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-4 border-t border-separator pr-4 pl-8 text-xs text-muted">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={isBusy ? "busy" : desktop ? "success" : "warning"} pulse={isBusy} />
        <span className="truncate">
          {isBusy ? globalTask.label : desktop ? "Ready · video-use" : "Browser preview · desktop required"}
        </span>
      </div>

      <div className="tabular-nums flex h-full shrink-0 items-center">
        {activeClipCount > 0 && (
          <button type="button" onClick={onOpenClips} title="Open running clip finder" className={`${item} text-accent`}>
            <Sparkles className="size-3" />
            {activeClipCount === 1 && globalTask.type === "analyzing"
              ? globalTask.label
              : activeClipCount === 1 ? "Finding clips" : `${activeClipCount} clip searches`}
          </button>
        )}
        <button
          type="button"
          onClick={onOpenJobs}
          disabled={!onOpenJobs}
          title="Open render jobs"
          className={item}
        >
          <Clapperboard className="size-3" />
          {activeRenderCount > 0
            ? `${activeRenderCount} rendering${typeof renderProgress === "number" ? ` · ${Math.round(renderProgress * 100)}%` : ""}`
            : "Renders"}
        </button>
        <button
          type="button"
          onClick={onOpenClis}
          disabled={!onOpenClis}
          title="Open tools & agents"
          className={item}
        >
          <Terminal className="size-3" />
          {cliAvailable}/{cliTotal} tools
        </button>
        <span className="flex h-full items-center gap-1.5 px-2">
          <CalendarClock className="size-3" />
          {queueCount} queued
        </span>
      </div>
    </footer>
  );
};
