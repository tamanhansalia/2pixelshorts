import React, { useEffect, useMemo, useState } from "react";
import { Segmented } from "../ui/Segmented";
import {
  BarChart3,
  CalendarClock,
  Check,
  ChevronDown,
  Clapperboard,
  Link2,
  ListChecks,
  Monitor,
  Moon,
  Plus,
  Send,
  Settings,
  Sun,
  Trash2,
} from "lucide-react";
import { SearchField, Spinner, Tag, TagGroup } from "@heroui/react";
import { Button } from "../ui/Button";
import { Logo } from "../ui/Logo";
import { StatusDot } from "../ui/StatusDot";
import {
  groupEntriesByDay,
  type SourceEntry,
  type SourceStatus,
} from "../../lib/studioProjects";
import type { StreamSidebarItem } from "../../lib/streamRuns";
import { clipFailureText } from "../../lib/streamAnalysis";
import { ClipAnalysisActivity, type ClipActivityItem } from "../jobs/ClipAnalysisActivity";
import { SIDEBAR_GROUPS_KEY as COLLAPSED_GROUPS_KEY } from "../../lib/appReset";

export type NavTab =
  | "studio"
  | "social"
  | "scheduler"
  | "performance"
  | "settings";
export type ColorMode = "light" | "dark" | "system";

export type SourceFilter = "all" | "rendering" | "ready" | "editing" | "failed";

const SOURCE_FILTERS: { id: SourceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "rendering", label: "Rendering" },
  { id: "ready", label: "Ready" },
  { id: "editing", label: "Editing" },
  { id: "failed", label: "Failed" },
];

/** "Ready" covers rendered outputs and queued posts alike. */
function matchSourceFilter(status: SourceStatus, filter: SourceFilter): boolean {
  if (filter === "all") return true;
  if (filter === "ready") return status === "completed" || status === "queued";
  return status === filter;
}

function loadCollapsedGroups(): string[] {
  try {
    if (typeof localStorage === "undefined") return ["older"];
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return ["older"];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === "string")
      : ["older"];
  } catch {
    return ["older"];
  }
}

interface SidebarProps {
  activeTab: NavTab;
  onNavigate: (tab: NavTab) => void;
  queueCount: number;
  colorMode: ColorMode;
  onColorModeChange: (mode: ColorMode) => void;
  sources?: SourceEntry[];
  selectedSourceId?: string | null;
  onSelectSource?: (id: string) => void;
  onNewSource?: () => void;
  onRemoveSource?: (id: string) => void;
  onRemoveSources?: (ids: string[]) => void;
  /** Stream links, including searches that are still running. */
  streams?: StreamSidebarItem[];
  selectedStreamUrl?: string | null;
  onSelectStream?: (url: string) => void;
  onRemoveStream?: (url: string) => void;
  clipJobs?: ClipActivityItem[];
  onDismissClipJob?: (url: string) => void;
}

const SOURCE_DOT: Record<SourceStatus, { status: "busy" | "success" | "warning" | "danger" | "idle"; pulse?: boolean; label: string }> = {
  rendering: { status: "busy", pulse: true, label: "Rendering" },
  queued: { status: "warning", label: "Queued" },
  completed: { status: "success", label: "Rendered" },
  failed: { status: "danger", label: "Failed" },
  editing: { status: "idle", label: "Editing" },
};

const NAV_ITEMS: {
  id: NavTab;
  label: string;
  description: string;
  icon: React.ReactNode;
  shortcut: string;
}[] = [
  {
    id: "studio",
    label: "Create",
    description: "Find and export shorts",
    icon: <Clapperboard className="size-4" />,
    shortcut: "1",
  },
  {
    id: "social",
    label: "Publish",
    description: "Send a short now",
    icon: <Send className="size-4" />,
    shortcut: "2",
  },
  {
    id: "scheduler",
    label: "Schedule",
    description: "Posts while the app is open",
    icon: <CalendarClock className="size-4" />,
    shortcut: "3",
  },
  {
    id: "performance",
    label: "Results",
    description: "Views and what works",
    icon: <BarChart3 className="size-4" />,
    shortcut: "5",
  },
  {
    id: "settings",
    label: "Settings",
    description: "Tools & keys",
    icon: <Settings className="size-4" />,
    shortcut: "4",
  },
];

const MODE_OPTIONS: { id: ColorMode; label: string; icon: React.ReactNode }[] = [
  { id: "light", label: "Light", icon: <Sun className="size-3.5" /> },
  { id: "dark", label: "Dark", icon: <Moon className="size-3.5" /> },
  { id: "system", label: "System", icon: <Monitor className="size-3.5" /> },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onNavigate,
  queueCount,
  colorMode,
  onColorModeChange,
  sources = [],
  selectedSourceId = null,
  onSelectSource,
  onNewSource,
  onRemoveSource,
  onRemoveSources,
  streams = [],
  selectedStreamUrl = null,
  onSelectStream,
  onRemoveStream,
  clipJobs = [],
  onDismissClipJob,
}) => {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<SourceFilter>("all");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsedGroups);
  const hasStreams = streams.length > 0;
  const [library, setLibrary] = useState<"streams" | "shorts">(() => {
    if (selectedStreamUrl && hasStreams) return "streams";
    if (hasStreams && sources.length === 0) return "streams";
    return "shorts";
  });

  useEffect(() => {
    if (!hasStreams && library === "streams") setLibrary("shorts");
  }, [hasStreams, library]);

  useEffect(() => {
    if (selectedStreamUrl) setLibrary("streams");
    else if (selectedSourceId) setLibrary("shorts");
  }, [selectedSourceId, selectedStreamUrl]);

  const showStreams = hasStreams && library === "streams";
  const showShorts = !hasStreams || library === "shorts";

  useEffect(() => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(collapsed));
      }
    } catch {
      // Collapse state is best-effort.
    }
  }, [collapsed]);

  const isFiltered = query.trim() !== "" || statusFilter !== "all";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sources.filter(
      (s) =>
        matchSourceFilter(s.status, statusFilter) &&
        (!q || s.label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)),
    );
  }, [sources, query, statusFilter]);

  const groups = useMemo(() => groupEntriesByDay(filtered), [filtered]);

  // Drop selection for rows that no longer exist (e.g. after a bulk remove).
  const liveSelected = useMemo(() => {
    const ids = new Set(sources.map((s) => s.id));
    return selectedIds.filter((id) => ids.has(id));
  }, [sources, selectedIds]);

  const renderedVisible = useMemo(
    () => filtered.filter((s) => s.status === "completed"),
    [filtered],
  );

  const toggleGroup = (key: string) =>
    setCollapsed((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );

  const toggleSelectMode = () => {
    setSelectMode((prev) => {
      if (prev) setSelectedIds([]);
      return !prev;
    });
  };

  const removeMany = (ids: string[]) => {
    if (ids.length === 0) return;
    if (onRemoveSources) onRemoveSources(ids);
    else ids.forEach((id) => onRemoveSource?.(id));
    setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
  };

  const rowBase =
    "group relative flex h-8 w-full items-center gap-2.5 rounded-md px-2 transition-colors";
  const rowActive = "bg-default text-foreground";
  const rowIdle =
    "text-muted hover:bg-default/60 hover:text-foreground";
  const iconButton =
    "flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-tertiary hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent";
  const libraryTab =
    "text-xs font-medium tracking-wide uppercase transition-colors";
  const libraryTabActive = "text-foreground";
  const libraryTabIdle = "text-muted hover:text-foreground";
  const rowIcon = "flex size-3.5 shrink-0 items-center justify-center";

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-separator">
      {/* Brand — sits on the window tone, level with the canvas top */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-5">
        <Logo size={22} title="" />
        <span className="truncate text-sm font-semibold tracking-tight text-foreground">
          2pixelshorts
        </span>
      </div>

      <nav
        aria-label="Primary"
        className=" flex-1 overflow-y-auto px-3 pt-1 pb-4"
      >
        <div className="space-y-px">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-current={isActive ? "page" : undefined}
                title={`${item.description} · Ctrl ${item.shortcut}`}
                className={`${rowBase} text-left ${isActive ? rowActive : rowIdle}`}
              >
                <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-[15px]">
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {item.label}
                </span>
                {item.id === "scheduler" && queueCount > 0 && (
                  <span className="tabular-nums min-w-5 rounded-[4px] bg-accent/15 px-1.5 text-center text-xs font-semibold text-accent">
                    {queueCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Streams and Shorts share one header so the labels sit on the same row. */}
        <div className="mt-5">
          <div className="flex h-6 items-center justify-between pr-0.5 pl-2">
            <div
              role={hasStreams ? "tablist" : undefined}
              aria-label={hasStreams ? "Library" : undefined}
              className="flex min-w-0 items-center gap-3"
            >
              {hasStreams ? (
                <button
                  type="button"
                  role="tab"
                  id="sidebar-tab-streams"
                  aria-controls="sidebar-panel-streams"
                  aria-selected={library === "streams"}
                  onClick={() => {
                    setSelectMode(false);
                    setLibrary("streams");
                  }}
                  className={`${libraryTab} ${
                    library === "streams" ? libraryTabActive : libraryTabIdle
                  }`}
                >
                  Streams
                </button>
              ) : null}
              {hasStreams ? (
                <button
                  type="button"
                  role="tab"
                  id="sidebar-tab-shorts"
                  aria-controls="sidebar-panel-shorts"
                  aria-selected={library === "shorts"}
                  onClick={() => setLibrary("shorts")}
                  className={`${libraryTab} ${
                    library === "shorts" ? libraryTabActive : libraryTabIdle
                  }`}
                >
                  Shorts
                  {showShorts && isFiltered ? (
                    <span className="tabular-nums normal-case">
                      {" "}
                      · {filtered.length}/{sources.length}
                    </span>
                  ) : null}
                </button>
              ) : (
                <span className={`${libraryTab} ${libraryTabIdle}`}>
                  Shorts
                  {isFiltered ? (
                    <span className="tabular-nums normal-case">
                      {" "}
                      · {filtered.length}/{sources.length}
                    </span>
                  ) : null}
                </span>
              )}
            </div>
            <span className="flex items-center">
              {showShorts && sources.length > 0 && (onRemoveSource || onRemoveSources) ? (
                <button
                  type="button"
                  onClick={toggleSelectMode}
                  title={selectMode ? "Done selecting" : "Select shorts to remove"}
                  aria-label={selectMode ? "Done selecting" : "Select shorts to remove"}
                  aria-pressed={selectMode}
                  className={`${iconButton} size-5 ${selectMode ? "bg-surface-tertiary text-foreground" : ""}`}
                >
                  <ListChecks className="size-3.5" />
                </button>
              ) : null}
              {onNewSource ? (
                <button
                  type="button"
                  onClick={onNewSource}
                  title="Start a new short"
                  aria-label="Start a new short"
                  className={`${iconButton} size-5`}
                >
                  <Plus className="size-3.5" />
                </button>
              ) : null}
            </span>
          </div>

          {showStreams ? (
            <div id="sidebar-panel-streams" role="tabpanel" aria-labelledby="sidebar-tab-streams" className="space-y-px">
              {streams.map((stream) => {
                const job = clipJobs.find((entry) => entry.url === stream.url);
                const isActive =
                  activeTab === "studio" && selectedStreamUrl === stream.url;
                const isBusy =
                  job?.status === "running" ||
                  job?.status === "watching" ||
                  stream.watching;
                return (
                  <div
                    key={stream.url}
                    className={`${rowBase} ${isActive ? rowActive : rowIdle}`}
                  >
                    <span className={rowIcon}>
                      {isBusy ? (
                        <Spinner size="sm" color="current" />
                      ) : (
                        <Link2 className="size-3.5" />
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => onSelectStream?.(stream.url)}
                      title={stream.url}
                      aria-current={isActive ? "page" : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span className="block min-w-0 flex-1 truncate text-sm">
                        {stream.title}
                      </span>
                      {stream.isLive ? (
                        <span className="shrink-0 text-[10px] font-semibold tracking-wide text-danger">LIVE</span>
                      ) : null}
                      {job?.status === "running"
                        ? (job.detail ? <span className="shrink-0 text-xs text-muted">Transcribing</span> : null)
                        : job?.status === "watching" || stream.watching ? <span className="text-xs text-muted">Watching</span>
                        : job?.status === "failed" ? <span className="text-xs text-danger" title={clipFailureText(job.error)}>Failed</span>
                        : stream.clipCount !== null ? (
                        <span className="tabular-nums shrink-0 text-xs text-muted group-hover:hidden">
                          {stream.clipCount}
                        </span>
                      ) : null}
                    </button>
                    {onRemoveStream && job?.status !== "running" ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveStream(stream.url);
                        }}
                        title={`Forget ${stream.title}`}
                        aria-label={`Forget ${stream.title}`}
                        className={`${iconButton} -mr-1 size-5 hover:text-danger ${
                          isActive
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                        }`}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {showShorts ? (
            <div
              id="sidebar-panel-shorts"
              role={hasStreams ? "tabpanel" : undefined}
              aria-labelledby={hasStreams ? "sidebar-tab-shorts" : undefined}
            >
          {sources.length > 0 ? (
            <div className="space-y-2 px-0.5 pt-1.5 pb-2">
              <SearchField
                fullWidth
                value={query}
                onChange={setQuery}
                aria-label="Search shorts"
              >
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder="Search" />
                  <SearchField.ClearButton />
                </SearchField.Group>
              </SearchField>
              <TagGroup
                aria-label="Filter by status"
                size="sm"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[statusFilter]}
                onSelectionChange={(keys) => {
                  const [next] = Array.from(keys);
                  if (next) setStatusFilter(next as SourceFilter);
                }}
              >
                <TagGroup.List>
                  {SOURCE_FILTERS.map((f) => (
                    <Tag key={f.id} id={f.id}>
                      {f.label}
                    </Tag>
                  ))}
                </TagGroup.List>
              </TagGroup>
            </div>
          ) : null}

          {sources.length === 0 ? (
            <Button
              variant="outline"
              size="sm"
              fullWidth
              icon={<Plus />}
              onClick={onNewSource}
              className="mt-1"
            >
              New short
            </Button>
          ) : groups.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted">
              No shorts match this filter.
            </p>
          ) : (
            <div className="space-y-2">
              {groups.map(({ group, entries }) => {
                const isCollapsed = collapsed.includes(group.key);
                return (
                  <div key={group.key}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={!isCollapsed}
                      className="flex h-6 w-full items-center gap-1 rounded-md px-2 text-left text-muted hover:text-foreground"
                    >
                      <ChevronDown
                        className={`size-3 shrink-0 transition-transform ${
                          isCollapsed ? "-rotate-90" : ""
                        }`}
                        aria-hidden
                      />
                      <span className="text-xs font-medium">
                        {group.label}
                      </span>
                      {group.sub && (
                        <span className="tabular-nums text-xs opacity-70">
                          {group.sub}
                        </span>
                      )}
                      <span className="tabular-nums ml-auto text-xs opacity-70">
                        {entries.length}
                      </span>
                    </button>
                    {!isCollapsed && (
                      <div className="space-y-px">
                        {entries.map((source) => {
                          const dot = SOURCE_DOT[source.status];
                          const isActive =
                            activeTab === "studio" &&
                            !selectedStreamUrl &&
                            selectedSourceId === source.id;
                          const isSelected = liveSelected.includes(source.id);
                          const highlighted = isActive || (selectMode && isSelected);
                          const isRendering = source.status === "rendering";
                          const tip = `${source.label} — ${dot.label}\n${source.id}`;
                          return (
                            <div
                              key={source.id}
                              className={`${rowBase} ${highlighted ? rowActive : rowIdle}`}
                            >
                              {selectMode ? (
                                <button
                                  type="button"
                                  role="checkbox"
                                  aria-checked={isSelected}
                                  aria-label={`Select ${source.label}`}
                                  disabled={isRendering}
                                  onClick={() => toggleSelect(source.id)}
                                  title={
                                    isRendering
                                      ? "Rendering shorts cannot be removed yet"
                                      : `Select ${source.label}`
                                  }
                                  className={`flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
                                    isSelected
                                      ? "border-accent bg-accent text-accent-foreground"
                                      : "border-border-tertiary text-transparent hover:border-muted"
                                  } ${isRendering ? "cursor-not-allowed opacity-40" : ""}`}
                                >
                                  <Check className="size-2.5" strokeWidth={3.5} />
                                </button>
                              ) : isRendering ? (
                                <span className={rowIcon}>
                                  <Spinner
                                    size="sm"
                                    color="current"
                                    aria-label={`${source.label} — rendering`}
                                  />
                                </span>
                              ) : (
                                <span className={rowIcon}>
                                  <StatusDot status={dot.status} pulse={dot.pulse} />
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  selectMode
                                    ? !isRendering && toggleSelect(source.id)
                                    : onSelectSource?.(source.id)
                                }
                                title={tip}
                                aria-current={isActive ? "page" : undefined}
                                className="flex min-w-0 flex-1 items-center text-left"
                              >
                                <span className="block min-w-0 flex-1 truncate text-sm">
                                  {source.label}
                                </span>
                              </button>
                              {!selectMode && onRemoveSource && !isRendering && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onRemoveSource(source.id);
                                  }}
                                  title={`Remove ${source.label} from sidebar`}
                                  aria-label={`Remove ${source.label} from sidebar`}
                                  className={`${iconButton} -mr-1 size-5 hover:text-danger ${
                                    isActive
                                      ? "opacity-100"
                                      : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                                  }`}
                                >
                                  <Trash2 className="size-3" />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {selectMode && sources.length > 0 ? (
            <div className="mt-3 space-y-2 rounded-2xl bg-surface p-2 shadow-surface">
              <div className="tabular-nums px-1 text-xs text-muted">
                {liveSelected.length} selected
              </div>
              <div className="flex gap-1">
                <Button
                  variant="danger-soft"
                  size="sm"
                  className="flex-1"
                  onClick={() => removeMany(liveSelected)}
                  disabled={liveSelected.length === 0}
                >
                  Remove
                </Button>
                <Button
                  variant="tertiary"
                  size="sm"
                  className="flex-1"
                  onClick={() => removeMany(renderedVisible.map((s) => s.id))}
                  disabled={renderedVisible.length === 0}
                  title="Remove all rendered shorts in view"
                >
                  Clear rendered
                </Button>
              </div>
            </div>
          ) : null}
            </div>
          ) : null}
        </div>
      </nav>

      <ClipAnalysisActivity jobs={clipJobs} onOpen={onSelectStream} onDismiss={onDismissClipJob} />

      {/* Footer: version + appearance */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 pr-3 pl-5">
        <span className="tabular-nums text-xs text-muted">v0.1.0</span>
        <Segmented
          label="Appearance"
          value={colorMode}
          onChange={(mode) => onColorModeChange(mode as ColorMode)}
          options={MODE_OPTIONS.map((option) => ({
            value: option.id,
            icon: option.icon,
            label: <span className="sr-only">{option.label} theme</span>,
          }))}
        />
      </div>
    </aside>
  );
};
