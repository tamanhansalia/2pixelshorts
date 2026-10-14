import React from "react";
import { EmptyState as HeroEmptyState } from "@heroui/react";
import { cn } from "../../lib/utils";

interface AppEmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
  /** Tighter padding for use inside small panels. */
  compact?: boolean;
}

/** Centered empty state on HeroUI EmptyState: glyph, title, guidance, action. */
export const EmptyState: React.FC<AppEmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
}) => {
  return (
    <HeroEmptyState
      className={cn(
        "flex flex-col items-center gap-1 text-center",
        compact ? "py-6" : "py-12",
        className,
      )}
    >
      <span className="mb-2 flex text-muted [&_svg]:size-6">{icon}</span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-xs text-sm text-muted">{description}</p>
      {action && <div className="mt-3">{action}</div>}
    </HeroEmptyState>
  );
};
