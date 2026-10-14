import React from "react";

interface LogoProps {
  /** Rendered width/height in px. */
  size?: number;
  className?: string;
  /** Accessible label. Pass an empty string when adjacent text names the app. */
  title?: string;
}

/** The supplied ribbon logo, exported at multiple resolutions for crisp UI. */
export const Logo: React.FC<LogoProps> = ({
  size = 32,
  className,
  title = "2pixelshorts",
}) => (
  <img
    src="/brand/logo-128.png"
    srcSet={[32, 64, 128, 256, 512, 1024]
      .map((width) => `/brand/logo-${width}.png ${width}w`)
      .join(", ")}
    sizes={`${size}px`}
    width={size}
    height={size}
    className={className}
    style={{ display: "block", objectFit: "contain", flexShrink: 0 }}
    alt={title}
    draggable={false}
  />
);
