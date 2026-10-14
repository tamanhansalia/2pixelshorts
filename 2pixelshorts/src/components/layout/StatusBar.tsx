import React from "react";
import { CalendarClock, Clapperboard, Terminal } from "lucide-react";
import { GlobalTaskStatus } from "../../types";
import { StatusDot } from "../ui/StatusDot";

interface StatusBarProps {
  globalTask: GlobalTaskStatus;
  cliAvailable: number;
  cliTotal: number;
  queueCount: number;
  activeRenderCount?: number;
  renderProgress?: number;
  onOpenJobs?: () => void;
  onOpenClis?: () => void;
}

const item =
  "flex h-full items-center gap-1.5 px-2.5 transition-colors hover:text-foreground";

export const StatusBar: React.FC<StatusBarProps> = ({
  globalTask,
  cliAvailable,
  cliTotal,
  queueCount,
  activeRenderCount = 0,
  renderProgress,
  onOpenJobs,
  onOpenClis,
}) => {
  const isBusy = globalTask.type !== "idle";

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-4 border-t border-separator pr-4 pl-8 text-xs text-muted">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={isBusy ? "busy" : "success"} pulse={isBusy} />
        <span className="truncate">
          {isBusy ? globalTask.label : "Ready · local engine"}
        </span>
      </div>

      <div className="tabular-nums flex h-full shrink-0 items-center">
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
