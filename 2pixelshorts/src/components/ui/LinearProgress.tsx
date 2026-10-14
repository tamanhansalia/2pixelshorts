import React from "react";
import { ProgressBar } from "@heroui/react";

interface LinearProgressProps {
  /** 0–100. Omit for indeterminate. */
  progress?: number;
  label?: string;
  className?: string;
}

export const LinearProgress: React.FC<LinearProgressProps> = ({
  progress,
  label = "Progress",
  className,
}) => {
  const isIndeterminate = typeof progress !== "number";
  return (
    <ProgressBar
      aria-label={label}
      value={isIndeterminate ? undefined : Math.min(100, Math.max(0, progress))}
      maxValue={100}
      isIndeterminate={isIndeterminate}
      color="accent"
      size="sm"
      className={className}
    >
      <ProgressBar.Track>
        <ProgressBar.Fill />
      </ProgressBar.Track>
    </ProgressBar>
  );
};
