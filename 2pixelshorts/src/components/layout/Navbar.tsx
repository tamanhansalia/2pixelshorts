import React from "react";
import { motion } from "framer-motion";
import { 
  Film, 
  Share2, 
  CalendarClock, 
  Settings
} from "lucide-react";
import { GlobalTaskStatus, HeroUiThemeId } from "../../types";
import { LinearProgress } from "../ui/LinearProgress";
import { HeroUiThemeSelector } from "../theme/HeroUiThemeSelector";

export type NavTab = "studio" | "social" | "scheduler" | "settings";

interface NavbarProps {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  availableCliCount: number;
  totalCliCount: number;
  globalTask: GlobalTaskStatus;
  onNavigateToClis?: () => void;
  currentTheme: HeroUiThemeId;
  onSelectTheme: (theme: HeroUiThemeId) => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  availableCliCount,
  totalCliCount: _totalCliCount,
  globalTask,
  onNavigateToClis,
  currentTheme,
  onSelectTheme,
}) => {
  const tabs = [
    { id: "studio", label: "Studio", icon: Film },
    { id: "social", label: "Social", icon: Share2 },
    { id: "scheduler", label: "Queue", icon: CalendarClock },
    { id: "settings", label: "Settings", icon: Settings },
  ] as const;

  return (
    <header className="h-11 border-b border-border bg-surface px-4 flex items-center justify-between sticky top-0 z-50 select-none font-sans">
      {/* Brand logo & Desktop Title */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="h-5 w-5 rounded bg-foreground text-background flex items-center justify-center font-bold text-[10px] tracking-tight">
          2P
        </div>
        <span className="font-semibold text-xs text-foreground tracking-tight">
          TUARI
        </span>
      </div>

      {/* Segmented Navigation */}
      <nav 
        role="tablist"
        aria-label="Main Navigation"
        className="flex items-center gap-0.5 bg-surface-secondary p-0.5 rounded-md border border-border"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTab(tab.id as NavTab)}
              className={`relative flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-foreground/50 ${
                isActive
                  ? "text-foreground font-semibold"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {isActive && (
                <motion.div
                  layoutId="activeNavSegment"
                  className="absolute inset-0 bg-surface rounded border border-border shadow-xs"
                  transition={{
                    type: "spring",
                    stiffness: 550,
                    damping: 42,
                  }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5 opacity-80" />
                <span>{tab.label}</span>
              </span>
            </button>
          );
        })}
      </nav>

      {/* Right Control Cluster: Theme Switcher & Status */}
      <div className="flex items-center gap-2 shrink-0">
        <HeroUiThemeSelector
          currentTheme={currentTheme}
          onSelectTheme={onSelectTheme}
        />

        <button
          type="button"
          onClick={() => {
            if (onNavigateToClis) {
              onNavigateToClis();
            } else {
              setActiveTab("settings");
            }
          }}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-secondary border border-border text-xs text-muted hover:text-foreground transition cursor-pointer whitespace-nowrap"
          title="CLI status"
        >
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            {globalTask.type !== "idle" ? (
              <>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-foreground opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-foreground"></span>
              </>
            ) : availableCliCount > 0 ? (
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success"></span>
            ) : (
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-muted"></span>
            )}
          </span>
          <span className="text-[11px] font-medium text-foreground">
            {globalTask.type !== "idle"
              ? globalTask.label
              : `${availableCliCount} CLIs`}
          </span>
        </button>
      </div>

      {/* Global Ambient Hairline Progress Bar */}
      {globalTask.type !== "idle" && (
        <LinearProgress
          progress={globalTask.type === "rendering" ? globalTask.progress : undefined}
          className="absolute bottom-0 left-0 right-0 z-50"
        />
      )}
    </header>
  );
};
