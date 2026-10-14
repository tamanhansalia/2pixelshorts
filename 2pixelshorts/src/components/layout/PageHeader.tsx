import React from "react";
import { cn } from "../../lib/utils";

interface PageHeaderProps {
  title: React.ReactNode;
  /** One line under the title: purpose, counts or file details. */
  description?: React.ReactNode;
  /** Small muted label above the title (e.g. the section a draft lives in). */
  eyebrow?: React.ReactNode;
  /** Right-aligned primary actions. */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * The single header every page opens with: title + description on the
 * left, actions on the right, sharing one baseline. Replaces the old
 * thin title bar + separate toolbar row.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  eyebrow,
  actions,
  className,
}) => (
  <header
    className={cn(
      "flex flex-wrap items-center justify-between gap-x-6 gap-y-3",
      className,
    )}
  >
    <div className="min-w-0">
      {eyebrow && (
        <div className="mb-1 text-xs font-medium text-muted">{eyebrow}</div>
      )}
      <h1 className="truncate text-2xl font-semibold text-foreground">
        {title}
      </h1>
      {description && (
        <div className="tabular-nums mt-1 truncate text-sm text-muted">
          {description}
        </div>
      )}
    </div>
    {actions && (
      <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
    )}
  </header>
);
