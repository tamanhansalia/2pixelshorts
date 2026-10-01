import React, { useState, useRef, useEffect } from "react";
import { Palette, Check, Sparkles } from "lucide-react";
import { HeroUiThemeId, HERO_UI_THEMES } from "../../types";

interface HeroUiThemeSelectorProps {
  currentTheme: HeroUiThemeId;
  onSelectTheme: (themeId: HeroUiThemeId) => void;
  compact?: boolean;
}

export const HeroUiThemeSelector: React.FC<HeroUiThemeSelectorProps> = ({
  currentTheme,
  onSelectTheme,
  compact = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isOpen]);

  const activeConfig = HERO_UI_THEMES.find((t) => t.id === currentTheme) || HERO_UI_THEMES[0];

  return (
    <div className="relative inline-block" ref={containerRef}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-2.5 py-1 rounded-md bg-surface-secondary border border-border text-xs text-muted hover:text-foreground transition cursor-pointer select-none ${
          isOpen ? "border-foreground/40 bg-surface-tertiary" : ""
        }`}
        title="HeroUI Theme Selector"
        aria-label="Change HeroUI Theme"
        aria-expanded={isOpen}
      >
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0 shadow-xs border border-white/20"
          style={{ backgroundColor: activeConfig.accent }}
        />
        {!compact && (
          <span className="text-[11px] font-medium text-foreground tracking-tight max-w-[110px] truncate">
            {activeConfig.name}
          </span>
        )}
        <Palette className="w-3.5 h-3.5 opacity-70 ml-0.5" />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 mt-1.5 w-72 rounded-xl bg-surface border border-border shadow-2xl p-2 z-50 animate-in fade-in zoom-in-95 duration-150 select-none">
          {/* Header */}
          <div className="px-2.5 py-2 border-b border-border mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-foreground" />
              <span className="text-xs font-semibold text-foreground tracking-tight">
                HeroUI Themes
              </span>
            </div>
            <span className="text-[10px] font-mono text-muted bg-surface-secondary px-1.5 py-0.5 rounded border border-border">
              v3 Design System
            </span>
          </div>

          {/* Theme List */}
          <div className="max-h-72 overflow-y-auto space-y-1 pr-0.5">
            {HERO_UI_THEMES.map((theme) => {
              const isSelected = currentTheme === theme.id;
              return (
                <button
                  type="button"
                  key={theme.id}
                  onClick={() => {
                    onSelectTheme(theme.id);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center justify-between p-2 rounded-lg text-left transition cursor-pointer ${
                    isSelected
                      ? "bg-surface-secondary border border-border shadow-xs"
                      : "hover:bg-surface-secondary/60 border border-transparent"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {/* Swatch Pill */}
                    <div className="flex items-center -space-x-1 shrink-0">
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-black/30 shadow-xs z-10"
                        style={{ backgroundColor: theme.accent }}
                      />
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-white/10"
                        style={{ backgroundColor: theme.surface }}
                      />
                    </div>

                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-foreground truncate">
                        {theme.name}
                      </div>
                      <div className="text-[10px] text-muted truncate">
                        {theme.tag}
                      </div>
                    </div>
                  </div>

                  {isSelected && (
                    <div className="w-4 h-4 rounded-full bg-foreground text-background flex items-center justify-center shrink-0 ml-2">
                      <Check className="w-3 h-3 stroke-[3]" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Footer Info */}
          <div className="mt-1.5 pt-1.5 border-t border-border px-2 text-[10px] text-muted flex items-center justify-between">
            <span>Tailwind CSS v4 & CSS Variables</span>
            <span className="font-mono">heroui.com</span>
          </div>
        </div>
      )}
    </div>
  );
};
