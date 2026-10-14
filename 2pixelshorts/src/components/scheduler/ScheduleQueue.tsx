import React, { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  Check,
  Film,
  FolderOpen,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { Label, ListBox, Select } from "@heroui/react";
import { ScheduleItem, SocialPublishPayload, TranscriptionStatus, ZernioAccount } from "../../types";
import type { QueueSeoPatch, QueueStatusFilter } from "../../lib/outbox";
import {
  DEFAULT_RELEASE_TIME,
  DEFAULT_TIMEZONE,
  filterQueueItems,
  formatRelease,
  isQueueItemOverdue,
  sortQueueBySchedule,
  splitSchedule,
} from "../../lib/outbox";
import {
  accountLabel,
  canonicalPlatformId,
  connectedPlatformIds,
  isPlatformConnected,
} from "../../lib/channels";
import { PLATFORMS, TIMEZONES } from "../social/SocialPublisher";
import { Button } from "../ui/Button";
import { PageHeader } from "../layout/PageHeader";
import { Badge } from "../ui/Badge";
import { Modal } from "../ui/Modal";
import { SectionCard } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Field, TextArea, TextInput } from "../ui/Field";
import { QuickScheduleCard, type QuickSeo } from "./QuickScheduleCard";

export interface QueueItemPatch {
  title: string;
  description: string;
  tags: string[];
  scheduled_for: string;
  timezone: string;
  /** Channels to post to. Omitted = leave the entry's channels untouched. */
  platforms?: string[];
  /** Gateway account ids matching platforms. Omitted = keep existing ids. */
  account_ids?: string[];
}

interface ScheduleQueueProps {
  queue: ScheduleItem[];
  /** Preferred removal handler (Delete button + confirm dialog). */
  onDeleteJob?: (id: string) => void;
  /** @deprecated Use onDeleteJob; kept as a fallback for existing callers. */
  onCancelJob?: (id: string) => void;
  /** Remove every completed entry; shown only when completed rows exist. */
  onClearCompleted?: () => void;
  onSyncJob: (id: string) => void | Promise<void>;
  onRetryJob: (id: string) => void | Promise<void>;
  onDispatchJob?: (id: string) => void | Promise<void>;
  onEditJob?: (id: string) => void;
  onUpdateJob?: (id: string, patch: QueueItemPatch) => void;
  onReanalyzeJob?: (id: string) => Promise<QueueSeoPatch | null>;
  onOpenFile?: (path: string) => void;
  onOpenFileLocation?: (path: string) => void;
  /** Finished render outputs not yet queued, with one-click Queue. */
  readyOutputs?: string[];
  onQueueOutput?: (outputPath: string) => void;
  /** Dismiss a finished output from history (row disappears, file kept). */
  onDismissOutput?: (outputPath: string) => void;
  onNewShort?: () => void;
  onNavigateToStudio: () => void;
  /** Queue a finished video directly: pick file, analyze, schedule. */
  onPickVideo?: () => Promise<string | null>;
  onAnalyzeVideo?: (videoPath: string) => Promise<QuickSeo>;
  onQueueShort?: (payload: SocialPublishPayload) => ScheduleItem;
  transcription?: TranscriptionStatus | null;
  /** Same connected-accounts source the Social page uses for its channel
   * picker. Without a key the picker shows saved channels read-only. */
  apiKey?: string;
  onGetAccounts?: (apiKey: string) => Promise<ZernioAccount[]>;
}

const STATUS_BADGE: Record<
  ScheduleItem["status"],
  { variant: "default" | "accent" | "success" | "danger"; label: string }
> = {
  queued: { variant: "default", label: "Queued" },
  publishing: { variant: "accent", label: "Dispatching" },
  completed: { variant: "success", label: "Completed" },
  failed: { variant: "danger", label: "Failed" },
};

const STATUS_FILTER_OPTIONS: { id: QueueStatusFilter; label: string }[] = [
  { id: "all", label: "All statuses" },
  { id: "queued", label: "Queued" },
  { id: "publishing", label: "Dispatching" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
];

export const ScheduleQueue: React.FC<ScheduleQueueProps> = ({
  queue,
  onDeleteJob,
  onCancelJob,
  onClearCompleted,
  onSyncJob,
  onRetryJob,
  onDispatchJob,
  onEditJob,
  onUpdateJob,
  onReanalyzeJob,
  onOpenFile,
  onOpenFileLocation,
  readyOutputs = [],
  onQueueOutput,
  onDismissOutput,
  onNewShort,
  onNavigateToStudio,
  onPickVideo,
  onAnalyzeVideo,
  onQueueShort,
  transcription,
  apiKey = "",
  onGetAccounts,
}) => {
  const startNew = onNewShort ?? onNavigateToStudio;
  const onRemoveJob = onDeleteJob ?? onCancelJob;
  const [jobToDelete, setJobToDelete] = useState<ScheduleItem | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Gateway calls (dispatch / sync / retry) are async with no per-row
  // feedback from the parent, so track the busy action here: the acting
  // button shows a spinner and the row's other actions lock until it
  // settles, preventing double-dispatches.
  const [busy, setBusy] = useState<{
    id: string;
    action: "dispatch" | "sync" | "retry";
  } | null>(null);

  const runRowAction = async (
    id: string,
    action: "dispatch" | "sync" | "retry",
    fn: (id: string) => void | Promise<void>,
  ) => {
    if (busy?.id === id) return;
    setBusy({ id, action });
    try {
      await fn(id);
    } finally {
      setBusy((prev) => (prev?.id === id ? null : prev));
    }
  };

  const confirmDelete = async () => {
    if (!jobToDelete || !onRemoveJob) return;
    setDeletingId(jobToDelete.id);
    await new Promise((r) => setTimeout(r, 120));
    onRemoveJob(jobToDelete.id);
    setDeletingId(null);
    setJobToDelete(null);
  };

  // In-place editor: title, description, tags, channels, release slot —
  // plus a per-video re-analysis that regenerates the SEO from the footage.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    description: "",
    tags: "",
    platforms: [] as string[],
    date: "",
    time: DEFAULT_RELEASE_TIME,
    timezone: DEFAULT_TIMEZONE,
  });
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const editingItem = queue.find((q) => q.id === editingId) ?? null;

  // Connected accounts for the channel picker: the same gateway source the
  // Social page reads (never assumed — empty when logged out).
  const [accounts, setAccounts] = useState<ZernioAccount[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const connectedIds = connectedPlatformIds(accounts);

  useEffect(() => {
    if (!editingId || !onGetAccounts || !apiKey.trim()) {
      if (!editingId) setAccounts([]);
      return;
    }
    let disposed = false;
    setIsLoadingAccounts(true);
    onGetAccounts(apiKey.trim())
      .then((list) => {
        if (!disposed) setAccounts(list);
      })
      .catch(() => {
        if (!disposed) setAccounts([]);
      })
      .finally(() => {
        if (!disposed) setIsLoadingAccounts(false);
      });
    return () => {
      disposed = true;
    };
  }, [editingId, apiKey, onGetAccounts]);

  const openEditor = (item: ScheduleItem) => {
    const { date, time } = splitSchedule(item.scheduled_for);
    setDraft({
      title: item.title,
      description: item.description ?? "",
      tags: (item.tags ?? []).join(", "),
      platforms: [...item.platforms],
      date,
      time,
      timezone: item.timezone || DEFAULT_TIMEZONE,
    });
    setEditingId(item.id);
  };

  const toggleDraftPlatform = (id: string) => {
    if (!connectedIds.includes(id.toLowerCase())) return;
    setDraft((d) => ({
      ...d,
      platforms: d.platforms.includes(id)
        ? d.platforms.filter((p) => p !== id)
        : [...d.platforms, id],
    }));
  };

  const handleReanalyze = async () => {
    if (!editingItem || !onReanalyzeJob) return;
    setIsAnalyzing(true);
    try {
      const patch = await onReanalyzeJob(editingItem.id);
      if (patch) {
        setDraft((d) => ({
          ...d,
          title: patch.title,
          description: patch.description,
          tags: patch.tags.join(", "),
        }));
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Edit-modal validation: title + date are required, and the time must
  // be a real HH:MM value — an empty time would otherwise save as
  // "YYYY-MM-DDT:00", which no date parser accepts.
  const isDraftTimeValid = /^\d{2}:\d{2}$/.test(draft.time.trim());
  const canSaveEditor =
    draft.title.trim().length > 0 &&
    draft.date.trim().length > 0 &&
    isDraftTimeValid;

  const handleSaveEditor = () => {
    if (!editingItem || !onUpdateJob || !canSaveEditor) return;
    // Same account mapping Social uses at publish time: each channel gets
    // its linked gateway account id. Without a live accounts list the ids
    // are omitted so the entry's existing ones survive.
    const accountIds =
      accounts.length > 0
        ? draft.platforms.map((p) => {
            const acc = accounts.find(
              (a) =>
                a.is_connected &&
                canonicalPlatformId(a.platform) === canonicalPlatformId(p),
            );
            return acc ? acc.id : p;
          })
        : undefined;
    onUpdateJob(editingItem.id, {
      title: draft.title.trim(),
      description: draft.description,
      tags: draft.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      scheduled_for: `${draft.date.trim()}T${draft.time.trim()}:00`,
      timezone: draft.timezone,
      platforms: [...draft.platforms],
      ...(accountIds !== undefined ? { account_ids: accountIds } : {}),
    });
    setEditingId(null);
  };

  // Saved channels whose link is currently gone (logged out or revoked):
  // shown read-only so they are never silently dropped on save.
  const staleDraftPlatforms = draft.platforms.filter(
    (p) => !connectedIds.includes(p.toLowerCase()),
  );

  // Inline edit-modal validation state: past-slot warning and the
  // empty-channels Post-now hint. Neither blocks saving — the entry stays
  // queued — but both explain what happens next.
  const draftSlotText =
    draft.date.trim() && isDraftTimeValid
      ? `${draft.date.trim()}T${draft.time.trim()}:00`
      : null;
  const draftSlotTime =
    draftSlotText !== null ? new Date(draftSlotText).getTime() : NaN;
  const isDraftSlotPast =
    draftSlotText !== null &&
    !Number.isNaN(draftSlotTime) &&
    draftSlotTime < Date.now();
  const isDraftChannelsEmpty = draft.platforms.length === 0;

  const waitingCount = queue.filter((q) => q.status === "queued").length;
  const failedCount = queue.filter((q) => q.status === "failed").length;
  const completedCount = queue.filter((q) => q.status === "completed").length;
  const hasQuickSchedule = Boolean(onPickVideo && onAnalyzeVideo && onQueueShort);
  const [statusFilter, setStatusFilter] = useState<QueueStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  // Oldest release first so the next post to go out is always on top.
  // Invalid dates sort last; the parent array is never mutated.
  const sortedQueue = useMemo(
    () =>
      sortQueueBySchedule(
        filterQueueItems(queue, { status: statusFilter, query: searchQuery }),
      ),
    [queue, statusFilter, searchQuery],
  );
  const isFiltering =
    statusFilter !== "all" || searchQuery.trim().length > 0;

  const rowIcon =
    "size-7 text-muted hover:text-foreground disabled:opacity-40";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Queue"
        description={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            <span className="font-medium text-foreground">{queue.length}</span>{" "}
            post{queue.length === 1 ? "" : "s"}
          </span>
          {waitingCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-warning" />
              {waitingCount} waiting
            </span>
          )}
          {failedCount > 0 && (
            <span className="flex items-center gap-1.5 text-danger">
              <span className="size-1.5 rounded-full bg-danger" />
              {failedCount} failed
            </span>
          )}
        </div>
        }
        actions={
          <Button variant="primary" icon={<Plus />} onClick={startNew}>
            New short
          </Button>
        }
      />

      <div
        className={`grid grid-cols-1 items-start gap-5 ${hasQuickSchedule ? "xl:grid-cols-[minmax(0,1fr)_24rem]" : ""}`}
      >
        <div className="min-w-0 space-y-5">
          <SectionCard
            title="Scheduled posts"
            description={
              queue.length === 0
                ? "Nothing queued"
                : "Post now, edit, or remove before release"
            }
            actions={
              onClearCompleted && completedCount > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 />}
                  onClick={onClearCompleted}
                  aria-label={`Clear ${completedCount} completed post${completedCount === 1 ? "" : "s"}`}
                  title="Remove every completed post from the queue"
                >
                  Clear completed
                </Button>
              ) : undefined
            }
            contentClassName="p-0"
          >
            {queue.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-separator pb-3">
                <div className="w-40">
                  <Select
                    variant="secondary"
                    selectedKey={statusFilter}
                    onSelectionChange={(key) =>
                      setStatusFilter(String(key) as QueueStatusFilter)
                    }
                    aria-label="Filter by status"
                  >
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {STATUS_FILTER_OPTIONS.map((opt) => (
                          <ListBox.Item
                            key={opt.id}
                            id={opt.id}
                            textValue={opt.label}
                          >
                            {opt.label}
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                </div>
                <TextInput
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search title or file…"
                  aria-label="Search queue by title or file"
                  className="max-w-56"
                />
                {isFiltering && (
                  <span className="tabular-nums text-xs text-muted">
                    {sortedQueue.length} of {queue.length}
                  </span>
                )}
              </div>
            )}
            {queue.length === 0 ? (
              <EmptyState
                icon={<CalendarClock />}
                title="Queue is empty"
                description={
                  hasQuickSchedule
                    ? "Add a finished video with the form, schedule one from Social, or start a new short in Studio."
                    : "Schedule a short from Social, or start a new short in Studio."
                }
                action={
                  <Button variant="secondary" onClick={startNew}>
                    Start a new short
                  </Button>
                }
              />
            ) : sortedQueue.length === 0 ? (
              <EmptyState
                icon={<CalendarClock />}
                title="No posts match"
                description="Try a different status or search."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setStatusFilter("all");
                      setSearchQuery("");
                    }}
                  >
                    Reset filters
                  </Button>
                }
              />
            ) : (
              <div
                role="table"
                aria-label="Scheduled posts"
                className="md:grid md:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
              >
                <div
                  role="row"
                  className="hidden h-8 items-center gap-x-6 rounded-lg bg-surface-secondary px-3 text-xs font-medium tracking-wide text-muted uppercase md:col-span-4 md:grid md:grid-cols-subgrid"
                >
                  <span role="columnheader">Post</span>
                  <span role="columnheader">Release</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">
                    <span className="sr-only">Actions</span>
                  </span>
                </div>
                <div className="divide-y divide-separator md:col-span-4 md:grid md:grid-cols-subgrid">
                  {sortedQueue.map((item) => {
                    const isDeleting = deletingId === item.id;
                    const rowBusy = busy?.id === item.id ? busy.action : null;
                    const release = formatRelease(item.scheduled_for);
                    const status = STATUS_BADGE[item.status];
                    const overdue = isQueueItemOverdue(item);
                    const fileName =
                      item.video_path.split(/[\\/]/).pop() || item.video_path;
                    const canPost =
                      (item.status === "queued" || item.status === "failed") &&
                      onDispatchJob;

                    return (
                      <div
                        key={item.id}
                        role="row"
                        className="group grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl px-3 py-3 transition-colors hover:bg-surface-secondary/50 md:col-span-4 md:grid-cols-subgrid md:items-center"
                      >
                        <div role="cell" className="flex min-w-0 items-center gap-3">
                          <span className="flex h-10 w-[23px] shrink-0 items-center justify-center rounded-[3px] border border-border bg-surface-tertiary text-muted">
                            <Film className="size-3" />
                          </span>
                          <div className="min-w-0">
                            <div
                              className="truncate text-sm font-medium text-foreground"
                              title={item.title}
                            >
                              {item.title}
                            </div>
                            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                              <span className="truncate font-mono" title={item.video_path}>
                                {fileName}
                              </span>
                              <span aria-hidden>·</span>
                              <span className="shrink-0">
                                {item.platforms.length > 0
                                  ? item.platforms.join(", ")
                                  : "No channels"}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div role="cell" className="tabular-nums text-sm leading-tight">
                          <div className="font-medium text-foreground">
                            {release.day}
                            <span className="ml-1.5 font-normal text-muted md:ml-0 md:block">
                              {release.time}
                            </span>
                          </div>
                        </div>

                        <div role="cell" className="min-w-0 space-y-0.5 md:max-w-40">
                          <Badge variant={status.variant} dot>
                            {status.label}
                          </Badge>
                          {overdue && (
                            <Badge variant="warning" dot>
                              Overdue
                            </Badge>
                          )}
                          {item.remote_status && (
                            <div
                              className="truncate text-xs text-muted"
                              title="Last status reported by the gateway"
                            >
                              {item.remote_status}
                            </div>
                          )}
                          {item.error && (
                            <div
                              className="line-clamp-2 text-xs text-danger"
                              title={item.error}
                            >
                              {item.error}
                            </div>
                          )}
                        </div>

                        <div
                          role="cell"
                          className="flex items-center gap-0.5"
                        >
                          {canPost && (
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<Send />}
                              isLoading={rowBusy === "dispatch"}
                              disabled={rowBusy !== null}
                              onClick={() =>
                                runRowAction(item.id, "dispatch", onDispatchJob)
                              }
                              aria-label={`Post ${item.title} now`}
                              title="Publish this short now"
                              className="mr-1 h-7"
                            >
                              {rowBusy === "dispatch" ? "Posting" : "Post now"}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            icon={<Pencil />}
                            disabled={rowBusy !== null}
                            onClick={() => openEditor(item)}
                            aria-label={`Edit ${item.title}`}
                            title="Edit title, SEO, channels & release time"
                            className={rowIcon}
                          />
                          {onOpenFile && (
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              icon={<Play />}
                              disabled={rowBusy !== null}
                              onClick={() => onOpenFile(item.video_path)}
                              aria-label={`Watch ${item.title}`}
                              title="Watch the short"
                              className={rowIcon}
                            />
                          )}
                          {onOpenFileLocation && (
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              icon={<FolderOpen />}
                              disabled={rowBusy !== null}
                              onClick={() => onOpenFileLocation(item.video_path)}
                              aria-label={`Open folder for ${item.title}`}
                              title="Show in folder"
                              className={rowIcon}
                            />
                          )}
                          {item.post_id && (
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              icon={<RefreshCw />}
                              isLoading={rowBusy === "sync"}
                              disabled={rowBusy !== null}
                              onClick={() => runRowAction(item.id, "sync", onSyncJob)}
                              aria-label={`Sync ${item.title}`}
                              title="Sync status from gateway"
                              className={rowIcon}
                            />
                          )}
                          {item.status === "failed" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              icon={<RotateCcw />}
                              isLoading={rowBusy === "retry"}
                              disabled={rowBusy !== null}
                              onClick={() => runRowAction(item.id, "retry", onRetryJob)}
                              aria-label={`Retry ${item.title}`}
                              title={
                                item.post_id
                                  ? "Retry publish"
                                  : "Retry publish (re-sends as a new post)"
                              }
                              className={rowIcon}
                            />
                          )}
                          {onRemoveJob && (
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              isLoading={isDeleting}
                              disabled={rowBusy !== null}
                              icon={<Trash2 />}
                              onClick={() => setJobToDelete(item)}
                              aria-label={`Delete ${item.title}`}
                              title="Delete from queue"
                              className={`${rowIcon} hover:text-danger`}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </SectionCard>

          {/* Finished renders that are not queued yet — no re-render needed. */}
          {readyOutputs.length > 0 && onQueueOutput && (
            <SectionCard
              title="Ready to queue"
              description="Rendered shorts that aren't scheduled yet"
              contentClassName="p-0"
            >
              <ul className="divide-y divide-separator">
                {readyOutputs.map((path) => {
                  const name = path.split(/[\\/]/).pop() || path;
                  return (
                    <li
                      key={path}
                      className="flex min-w-0 items-center justify-between gap-3 py-2.5"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex h-10 w-[23px] shrink-0 items-center justify-center rounded-[3px] border border-border bg-surface-tertiary text-muted">
                          <Film className="size-3" />
                        </span>
                        <div className="min-w-0">
                          <div
                            className="truncate text-sm font-medium text-foreground"
                            title={name}
                          >
                            {name}
                          </div>
                          <div
                            className="truncate font-mono text-xs text-muted"
                            title={path}
                          >
                            {path}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {onDismissOutput && (
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            icon={<X />}
                            onClick={() => onDismissOutput(path)}
                            aria-label={`Dismiss ${name}`}
                            title="Dismiss from history (file stays on disk)"
                            className="size-7 text-muted hover:text-foreground"
                          />
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Plus />}
                          onClick={() => onQueueOutput(path)}
                          aria-label={`Queue ${name} for posting`}
                        >
                          Queue
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </SectionCard>
          )}
        </div>

        {/* Queue any finished video directly: analyze once, schedule here. */}
        {onPickVideo && onAnalyzeVideo && onQueueShort && (
          <div className="min-w-0 xl:sticky xl:top-0">
            <QuickScheduleCard
              onPickVideo={onPickVideo}
              onAnalyzeVideo={onAnalyzeVideo}
              onQueueShort={onQueueShort}
              transcription={transcription}
            />
          </div>
        )}
      </div>

      <Modal
        isOpen={!!editingItem}
        onClose={() => setEditingId(null)}
        size="lg"
        icon={<Pencil className="size-4" />}
        title="Edit queued post"
        description={
          editingItem
            ? `Retitle, refresh the SEO, or move the release slot for ${editingItem.video_path.split(/[\\/]/).pop() || editingItem.video_path}.`
            : undefined
        }
        footer={
          <>
            {onEditJob && editingItem && (
              <Button
                variant="ghost"
                onClick={() => {
                  onEditJob(editingItem.id);
                  setEditingId(null);
                }}
              >
                Open in Social
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={() => setEditingId(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!canSaveEditor || !onUpdateJob}
              onClick={handleSaveEditor}
              title={
                !draft.title.trim()
                  ? "Enter a post title first"
                  : !draft.date.trim()
                    ? "Pick a release date first"
                    : !isDraftTimeValid
                      ? "Enter a release time (HH:MM) first"
                      : "Save changes"
              }
            >
              Save changes
            </Button>
          </>
        }
      >
        {editingItem && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-secondary px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  Regenerate title & SEO from the video
                </div>
                <div className="tabular-nums text-xs text-muted">
                  {draft.platforms.length > 0
                    ? `Posts to ${draft.platforms.join(", ")}`
                    : "No channels picked yet — pick them below or in Social"}
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                isLoading={isAnalyzing}
                disabled={isAnalyzing || !onReanalyzeJob}
                icon={<Wand2 />}
                onClick={handleReanalyze}
                title={
                  onReanalyzeJob
                    ? "Regenerate title, description & tags from the video"
                    : undefined
                }
              >
                {isAnalyzing ? "Analyzing" : "Re-analyze video"}
              </Button>
            </div>

            <Field label="Post title">
              <TextInput
                value={draft.title}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, title: e.target.value }))
                }
                aria-label="Queued post title"
              />
            </Field>

            <Field label="Description">
              <TextArea
                rows={5}
                value={draft.description}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, description: e.target.value }))
                }
                aria-label="Queued post description"
              />
            </Field>

            <Field
              label="Search tags"
              hint="Comma-separated — posted per platform"
            >
              <TextInput
                value={draft.tags}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, tags: e.target.value }))
                }
                placeholder="rust, shorts, coding"
                aria-label="Queued post tags"
              />
            </Field>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-foreground">
                Channels{" "}
                <span className="font-normal text-muted">
                  ({draft.platforms.length} selected)
                </span>
              </Label>
              {!apiKey.trim() ? (
                <p className="text-xs leading-snug text-muted">
                  Add your Zernio API key (Social → API key) to sync linked
                  channels.
                  {draft.platforms.length > 0
                    ? ` Saved: ${draft.platforms.join(", ")} — kept as-is.`
                    : " Channels can also be picked later in Social."}
                </p>
              ) : isLoadingAccounts ? (
                <p className="text-xs text-muted">
                  Syncing linked channels…
                </p>
              ) : connectedIds.length === 0 ? (
                <p className="text-xs leading-snug text-muted">
                  No channels linked yet — link them on the Social page.
                  {draft.platforms.length > 0
                    ? ` Saved: ${draft.platforms.join(", ")} — kept as-is.`
                    : ""}
                </p>
              ) : (
                <div
                  className="flex flex-wrap gap-1.5"
                  role="group"
                  aria-label="Channels for this post"
                >
                  {PLATFORMS.map((platform) => {
                    const isSelected = draft.platforms.includes(platform.id);
                    const acc = accounts.find(
                      (a) =>
                        a.is_connected &&
                        canonicalPlatformId(a.platform) === platform.id,
                    );
                    const isConnected = isPlatformConnected(
                      accounts,
                      platform.id,
                    );
                    return (
                      <button
                        key={platform.id}
                        type="button"
                        role="checkbox"
                        aria-checked={isSelected}
                        aria-label={`Post to ${platform.name}`}
                        title={
                          acc
                            ? accountLabel(acc)
                            : isConnected
                              ? "Connected"
                              : "Not linked — link it on the Social page"
                        }
                        disabled={!isConnected}
                        onClick={() => toggleDraftPlatform(platform.id)}
                        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                          isSelected
                            ? "border-accent bg-accent/10 text-foreground"
                            : "border-border text-muted hover:bg-surface-secondary"
                        }`}
                      >
                        <span
                          className={`flex size-3.5 items-center justify-center rounded-[4px] border ${
                            isSelected
                              ? "border-accent bg-accent text-accent-foreground"
                              : "border-border-tertiary text-transparent"
                          }`}
                        >
                          <Check className="size-2.5" strokeWidth={4} />
                        </span>
                        {platform.name}
                      </button>
                    );
                  })}
                </div>
              )}
              {apiKey.trim() &&
                !isLoadingAccounts &&
                staleDraftPlatforms.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted">
                      Saved but no longer linked (kept on save):
                    </span>
                    {staleDraftPlatforms.map((p) => (
                      <span
                        key={p}
                        className="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 font-mono text-xs text-muted"
                      >
                        {p}
                        <button
                          type="button"
                          aria-label={`Remove ${p} from this post`}
                          title={`Remove ${p} from this post`}
                          onClick={() =>
                            setDraft((d) => ({
                              ...d,
                              platforms: d.platforms.filter((x) => x !== p),
                            }))
                          }
                          className="font-sans text-sm leading-none hover:text-danger"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              {isDraftChannelsEmpty && (
                <p
                  className="text-xs leading-snug text-warning"
                  role="status"
                >
                  No channels selected — Post now is blocked until you pick
                  at least one channel. You can still save; the entry stays
                  queued.
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
              <Field label="Release date">
                <TextInput
                  type="date"
                  value={draft.date}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, date: e.target.value }))
                  }
                  aria-label="Release date"
                />
              </Field>
              <Field label="Release time">
                <TextInput
                  type="time"
                  value={draft.time}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, time: e.target.value }))
                  }
                  aria-label="Release time"
                />
                {!isDraftTimeValid && (
                  <p
                    className="mt-1 text-xs leading-snug text-danger"
                    role="alert"
                  >
                    Enter a release time (HH:MM) — an empty time can&apos;t
                    be saved.
                  </p>
                )}
              </Field>
              <div>
                <Label className="mb-1.5 block text-xs font-medium text-foreground">
                  Timezone
                </Label>
                <Select
                  variant="secondary"
                  selectedKey={draft.timezone}
                  onSelectionChange={(key) =>
                    setDraft((d) => ({ ...d, timezone: String(key) }))
                  }
                  aria-label="Timezone"
                >
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {TIMEZONES.map((tz) => (
                        <ListBox.Item
                          key={tz.id}
                          id={tz.id}
                          textValue={tz.label}
                        >
                          {tz.label}
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            </div>
            {isDraftSlotPast && (
              <p
                className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-snug text-warning"
                role="status"
              >
                This release slot is in the past — the post will show as
                Overdue until you move it to a future time or post it now.
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!jobToDelete}
        onClose={() => setJobToDelete(null)}
        size="sm"
        icon={<Trash2 className="size-4" />}
        title="Delete queued post"
        description="This permanently removes the post from the schedule queue. The video file stays on disk."
        footer={
          <>
            <Button variant="ghost" onClick={() => setJobToDelete(null)}>
              Keep in queue
            </Button>
            <Button
              variant="danger"
              isLoading={!!deletingId}
              onClick={confirmDelete}
            >
              Delete
            </Button>
          </>
        }
      >
        {jobToDelete && (
          <div className="space-y-1 rounded-md border border-border bg-surface-secondary p-3">
            <div className="text-sm font-semibold text-foreground">
              {jobToDelete.title}
            </div>
            <div className="truncate font-mono text-xs text-muted">
              {jobToDelete.video_path}
            </div>
            <div className="text-xs text-muted">
              Scheduled for{" "}
              {(() => {
                const r = formatRelease(jobToDelete.scheduled_for);
                return r.time ? `${r.day} ${r.time}` : r.day || "—";
              })()}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
