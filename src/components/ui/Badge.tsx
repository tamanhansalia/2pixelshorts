import React from "react";
import { Chip as HeroChip } from "@heroui/react";

export interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "accent" | "success" | "warning" | "danger" | "neutral";
  size?: "sm" | "md";
  dot?: boolean;
  className?: string;
}

const COLOR_MAP = {
  default: "default",
  accent: "accent",
  success: "success",
  warning: "warning",
  danger: "danger",
  neutral: "default",
} as const;

/** Status badge built on HeroUI v3 Chip (soft variant). */
export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "default",
  size = "sm",
  dot = false,
  className,
}) => {
  return (
    <HeroChip
      color={COLOR_MAP[variant]}
      variant={variant === "neutral" ? "secondary" : "soft"}
      size={size}
      className={className}
    >
      {dot && (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      )}
      {children}
    </HeroChip>
  );
};
