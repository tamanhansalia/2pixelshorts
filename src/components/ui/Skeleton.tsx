import React from "react";
import { Skeleton as HeroSkeleton } from "@heroui/react";

export const Skeleton: React.FC<{ className?: string }> = ({ className }) => {
  return <HeroSkeleton className={className} />;
};

export const ToolRowSkeleton: React.FC = () => {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <HeroSkeleton className="size-2 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <HeroSkeleton className="h-3.5 w-40" />
        <HeroSkeleton className="h-2.5 w-3/5" />
      </div>
      <HeroSkeleton className="h-2.5 w-20 shrink-0" />
      <HeroSkeleton className="h-5 w-9 shrink-0 rounded-full" />
    </div>
  );
};
