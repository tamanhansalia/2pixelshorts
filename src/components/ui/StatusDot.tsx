import React from "react";

interface StatusDotProps {
  status: "success" | "warning" | "danger" | "idle" | "busy";
  pulse?: boolean;
  className?: string;
}

const COLOR: Record<StatusDotProps["status"], string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  idle: "bg-muted",
  busy: "bg-accent",
};

/** Small status indicator dot used in the sidebar and status bar. */
export const StatusDot: React.FC<StatusDotProps> = ({
  status,
  pulse = false,
  className = "",
}) => {
  return (
    <span className={`relative flex size-2 shrink-0 ${className}`}>
      {pulse && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${COLOR[status]}`}
        />
      )}
      <span
        className={`relative inline-flex size-2 rounded-full ${COLOR[status]}`}
      />
    </span>
  );
};
