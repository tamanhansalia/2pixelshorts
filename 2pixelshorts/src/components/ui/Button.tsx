import React from "react";
import { Button as HeroButton, Spinner } from "@heroui/react";

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  variant?:
    | "primary"
    | "secondary"
    | "tertiary"
    | "ghost"
    | "outline"
    | "danger"
    | "danger-soft";
  size?: "sm" | "md";
  isLoading?: boolean;
  icon?: React.ReactNode;
  iconOnly?: boolean;
  fullWidth?: boolean;
}

/**
 * App button — thin wrapper over HeroUI v3 Button with identical variant/size
 * names, plus loading-state and leading-icon conveniences.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = "secondary",
      size = "md",
      isLoading = false,
      icon,
      iconOnly = false,
      fullWidth = false,
      className,
      disabled,
      type = "button",
      ...props
    },
    ref,
  ) => {
    return (
      <HeroButton
        ref={ref as React.Ref<HTMLButtonElement>}
        variant={variant}
        size={size}
        isDisabled={disabled || isLoading}
        isIconOnly={iconOnly}
        fullWidth={fullWidth}
        type={type}
        className={className}
        {...(props as Record<string, unknown>)}
      >
        {isLoading ? (
          <Spinner size="sm" color="current" />
        ) : (
          icon
        )}
        {!iconOnly && children}
      </HeroButton>
    );
  },
);

Button.displayName = "Button";
