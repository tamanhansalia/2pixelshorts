import React from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/utils";

export interface StudioStepMeta {
  id: string;
  title: string;
  hint: string;
  icon: React.ReactNode;
}

interface StudioStepperProps {
  steps: StudioStepMeta[];
  activeIndex: number;
  completed: boolean[];
  onSelect: (index: number) => void;
}

/** Numbered progress row: circle + label + connector; every step is clickable. */
export const StudioStepper: React.FC<StudioStepperProps> = ({
  steps,
  activeIndex,
  completed,
  onSelect,
}) => {
  return (
    <nav aria-label="Studio steps">
      {/* Connectors are their own flex-1 items so every gap is equal no
          matter how long each label is; the steps themselves never stretch. */}
      <ol className="flex items-center gap-3">
        {steps.map((step, index) => {
          const isActive = index === activeIndex;
          const isDone = completed[index] && !isActive;
          const isLast = index === steps.length - 1;
          return (
            <React.Fragment key={step.id}>
              <li className="flex shrink-0">
                <button
                  type="button"
                  onClick={() => onSelect(index)}
                  aria-current={isActive ? "step" : undefined}
                  title={step.hint}
                  className={cn(
                    "group flex h-8 items-center gap-2 rounded-md text-sm whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    isActive
                      ? "font-semibold text-foreground"
                      : "font-medium text-muted hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "tabular-nums flex size-[22px] shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                      isActive
                        ? "border-accent bg-accent text-accent-foreground"
                        : isDone
                          ? "border-accent/40 bg-accent/12 text-accent"
                          : "border-border-tertiary text-muted group-hover:border-muted",
                    )}
                  >
                    {isDone ? <Check className="size-3" strokeWidth={3} /> : index + 1}
                  </span>
                  <span className="hidden sm:inline">{step.title}</span>
                </button>
              </li>
              {!isLast && (
                <li
                  aria-hidden
                  role="presentation"
                  className={cn(
                    "h-px min-w-4 flex-1",
                    isDone ? "bg-accent/40" : "bg-border",
                  )}
                />
              )}
            </React.Fragment>
          );
        })}
      </ol>
    </nav>
  );
};
