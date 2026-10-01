import React from "react";
import { ProgressBar } from "@heroui/react";

interface LinearProgressProps {
  progress?: number; // 0 to 100
  className?: string;
}

export const LinearProgress: React.FC<LinearProgressProps> = ({ progress, className = "" }) => {
  const isIndeterminate = typeof progress !== "number";

  return (
    <ProgressBar
      aria-label="Task Progress"
      value={!isIndeterminate ? Math.min(100, Math.max(0, progress)) : undefined}
      isIndeterminate={isIndeterminate}
      className={`w-full ${className}`}
    >
      <ProgressBar.Track className="h-1 bg-surface-tertiary rounded-full overflow-hidden relative">
        <ProgressBar.Fill className="h-full bg-foreground rounded-full transition-all duration-300 ease-out" />
      </ProgressBar.Track>
    </ProgressBar>
  );
};
