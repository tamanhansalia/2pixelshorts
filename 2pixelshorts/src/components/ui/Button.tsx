import React from "react";
import { Button as HeroButton } from "@heroui/react";
import { Loader2 } from "lucide-react";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "outline";
  size?: "xs" | "sm" | "md" | "lg";
  isLoading?: boolean;
  icon?: React.ReactNode;
  iconPlacement?: "start" | "end";
  fullWidth?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = "secondary",
      size = "sm",
      isLoading = false,
      icon,
      iconPlacement = "start",
      fullWidth = false,
      className = "",
      disabled,
      ...props
    },
    ref
  ) => {
    // Desktop sizes
    const sizeClasses = {
      xs: "h-7 px-2.5 text-[11px] gap-1.5",
      sm: "h-8 px-3 text-xs gap-2",
      md: "h-9 px-4 text-xs gap-2.5",
      lg: "h-10 px-5 text-sm gap-3",
    }[size];

    // Desktop variants (monochrome quiet luxury)
    const variantClasses = {
      primary:
        "bg-foreground text-background font-semibold hover:opacity-90 shadow-xs border border-transparent active:scale-[0.99]",
      secondary:
        "bg-surface-secondary text-foreground font-medium border border-border hover:bg-surface-tertiary hover:border-muted/50 active:scale-[0.99]",
      ghost:
        "bg-transparent text-muted hover:text-foreground hover:bg-surface-secondary active:scale-[0.99]",
      outline:
        "bg-transparent text-foreground border border-border hover:bg-surface-secondary active:scale-[0.99]",
      danger:
        "bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20 active:scale-[0.99]",
    }[variant];

    return (
      <HeroButton
        ref={ref}
        isDisabled={disabled || isLoading}
        className={`inline-flex items-center justify-center rounded-md transition-all duration-150 select-none outline-none focus-visible:ring-1 focus-visible:ring-foreground/50 disabled:opacity-50 disabled:pointer-events-none cursor-pointer ${sizeClasses} ${variantClasses} ${
          fullWidth ? "w-full" : "w-auto"
        } ${className}`}
        {...(props as any)}
      >
        {isLoading && (
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-current" />
        )}
        {!isLoading && icon && iconPlacement === "start" && (
          <span className="shrink-0">{icon}</span>
        )}
        {children && <span>{children}</span>}
        {!isLoading && icon && iconPlacement === "end" && (
          <span className="shrink-0">{icon}</span>
        )}
      </HeroButton>
    );
  }
);

Button.displayName = "Button";
