import React from "react";
import { Card } from "@heroui/react";
import { cn } from "../../lib/utils";

interface SectionCardProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Small leading glyph in the header. Optional — most panels read better without. */
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  /** Render without the header row (title used as aria-label). */
  bare?: boolean;
}

/**
 * The app's panel: a stock HeroUI Card (header · content · footer) with an
 * optional actions slot beside the title.
 */
export const SectionCard: React.FC<SectionCardProps> = ({
  title,
  description,
  icon,
  actions,
  children,
  footer,
  className,
  contentClassName,
  bare = false,
}) => {
  return (
    <Card
      aria-label={bare && typeof title === "string" ? title : undefined}
      className={cn("min-w-0", className)}
    >
      {!bare && (
        <Card.Header className="flex-row items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {icon && (
              <span className="flex shrink-0 text-muted [&_svg]:size-4">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              <Card.Title>{title}</Card.Title>
              {description && (
                <Card.Description>{description}</Card.Description>
              )}
            </div>
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          )}
        </Card.Header>
      )}
      <Card.Content className={cn("min-w-0", contentClassName)}>
        {children}
      </Card.Content>
      {footer && <Card.Footer className="gap-2">{footer}</Card.Footer>}
    </Card>
  );
};

/** Muted uppercase eyebrow used for in-panel sub-sections. */
export const SubHeading: React.FC<{
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}> = ({ children, className, action }) => (
  <div className={cn("flex items-center justify-between gap-2", className)}>
    <span className="text-xs font-medium text-muted">{children}</span>
    {action}
  </div>
);
