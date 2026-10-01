import React from "react";
import { Chip as HeroChip } from "@heroui/react";

export interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "neutral";
  size?: "xs" | "sm";
  dot?: boolean;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "default",
  size = "sm",
  dot = false,
  className = "",
}) => {
  const variantStyles = {
    default: "bg-surface-secondary text-muted border-border",
    neutral: "bg-surface-tertiary text-foreground border-border",
    success: "bg-success/10 text-success border-success/30",
    warning: "bg-warning/10 text-warning border-warning/30",
    danger: "bg-danger/10 text-danger border-danger/30",
  }[variant];

  const dotColor = {
    default: "bg-muted",
    neutral: "bg-foreground",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
  }[variant];

  const sizeStyles = {
    xs: "text-[10px] px-1.5 py-0.5",
    sm: "text-[11px] px-2 py-0.5",
  }[size];

  return (
    <HeroChip
      className={`inline-flex items-center gap-1.5 rounded font-medium border tracking-tight ${sizeStyles} ${variantStyles} ${className}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`} />}
      <span>{children}</span>
    </HeroChip>
  );
};
