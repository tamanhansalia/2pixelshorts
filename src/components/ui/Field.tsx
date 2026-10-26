import React from "react";
import {
  Description as HeroDescription,
  Input as HeroInput,
  Label as HeroLabel,
  TextArea as HeroTextArea,
  TextField as HeroTextField,
  type InputProps as HeroInputProps,
  type TextAreaProps as HeroTextAreaProps,
} from "@heroui/react";

/** Labeled form field: label + control + optional hint, wired via TextField. */
export const Field: React.FC<{
  label: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ label, hint, action, children, className }) => {
  return (
    <HeroTextField fullWidth className={`min-w-0 gap-2 ${className ?? ""}`}>
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <HeroLabel>{label}</HeroLabel>
        {action}
      </div>
      {children}
      {hint && (
        <HeroDescription>{hint}</HeroDescription>
      )}
    </HeroTextField>
  );
};

/** Plain label for controls that are not text fields (segmented, select). */
export const ControlLabel: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <HeroLabel className={`mb-1.5 block ${className ?? ""}`}>{children}</HeroLabel>
);

/** Full-width HeroUI inputs. */
// "secondary" is HeroUI's variant for fields placed on a surface (cards).
export const TextInput: React.FC<HeroInputProps> = (props) => (
  <HeroInput fullWidth variant="secondary" {...props} />
);

export const TextArea: React.FC<HeroTextAreaProps> = (props) => (
  <HeroTextArea fullWidth variant="secondary" {...props} />
);
