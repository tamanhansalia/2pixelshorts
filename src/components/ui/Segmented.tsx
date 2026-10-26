import React from "react";
import { Tabs } from "@heroui/react";
import { cn } from "../../lib/utils";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

interface SegmentedProps<T extends string = string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  /** Stretch the control to the container width. */
  fill?: boolean;
}

/**
 * Single-select segmented control — the stock HeroUI Tabs (pill track with
 * a sliding indicator), used without panels.
 */
export function Segmented<T extends string = string>({
  label,
  value,
  onChange,
  options,
  className,
  fill = false,
}: SegmentedProps<T>) {
  return (
    <Tabs
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key) as T)}
      className={cn(fill ? "w-full" : "w-fit max-w-full", className)}
    >
      <Tabs.ListContainer className={cn("max-w-full overflow-x-auto", fill && "w-full")}>
        <Tabs.List aria-label={label} className={fill ? "w-full" : undefined}>
          {options.map((option) => (
            <Tabs.Tab
              key={option.value}
              id={option.value}
              className={cn(
                "w-auto gap-1.5 whitespace-nowrap [&_svg]:size-3.5",
                // Stretched: tabs start at their label width and share the
                // leftover space, so long labels never get clipped.
                fill && "flex-auto px-3",
              )}
            >
              {option.icon}
              {option.label}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}
