import React from "react";
import { Card as HeroCard } from "@heroui/react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  variant?: "default" | "elevated" | "flat" | "interactive";
  className?: string;
}

export const Card: React.FC<CardProps> = ({
  children,
  variant = "default",
  className = "",
  ...props
}) => {
  const variantStyles = {
    default: "bg-surface border-border",
    elevated: "bg-surface-secondary border-border shadow-xs",
    flat: "bg-surface-secondary/50 border-border/70",
    interactive:
      "bg-surface border-border hover:border-muted/80 transition-colors cursor-pointer",
  }[variant];

  return (
    <HeroCard
      className={`rounded-lg border p-5 ${variantStyles} ${className}`}
      {...(props as any)}
    >
      {children}
    </HeroCard>
  );
};

export const CardHeader: React.FC<{
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}> = ({ title, description, action, className = "" }) => {
  return (
    <div className={`flex items-start justify-between gap-4 pb-4 border-b border-border/80 ${className}`}>
      <div className="space-y-1">
        <div className="text-xs font-semibold text-foreground tracking-tight flex items-center gap-2">
          {title}
        </div>
        {description && (
          <p className="text-xs text-muted leading-relaxed max-w-xl">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
};
