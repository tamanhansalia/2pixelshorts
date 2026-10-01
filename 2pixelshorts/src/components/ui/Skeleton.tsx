import React from "react";
import { Skeleton as HeroSkeleton } from "@heroui/react";

interface SkeletonProps {
  className?: string;
}

export const Skeleton: React.FC<SkeletonProps> = ({ className = "" }) => {
  return (
    <HeroSkeleton
      className={`rounded-lg bg-surface-secondary/80 border border-border/50 ${className}`}
    />
  );
};

export const ToolCardSkeleton: React.FC = () => {
  return (
    <div className="p-4 rounded-lg bg-surface border border-border space-y-3">
      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          <HeroSkeleton className="h-4 w-28 rounded-md bg-surface-secondary" />
          <HeroSkeleton className="h-3 w-16 rounded-md bg-surface-tertiary" />
        </div>
        <HeroSkeleton className="h-5 w-12 rounded-full bg-surface-secondary" />
      </div>
      <div className="space-y-1.5 pt-1">
        <HeroSkeleton className="h-3 w-full rounded-md bg-surface-tertiary" />
        <HeroSkeleton className="h-3 w-4/5 rounded-md bg-surface-tertiary" />
      </div>
      <div className="pt-2 border-t border-border/60 flex justify-between">
        <HeroSkeleton className="h-3 w-12 rounded bg-surface-tertiary" />
        <HeroSkeleton className="h-3 w-16 rounded bg-surface-tertiary" />
      </div>
    </div>
  );
};
