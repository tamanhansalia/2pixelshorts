import React, { useState, useEffect } from "react";
import {
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  Film,
  Key,
  RefreshCw,
  Send,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { ListBox, Select, Spinner } from "@heroui/react";
import { ScheduleItem, SocialPublishPayload, ZernioAccount } from "../../types";
import {
  DEFAULT_TIMEZONE,
  splitSchedule,
  type SelectableShort,
} from "../../lib/outbox";
import {
  accountLabel,
  canDispatch,
  canonicalPlatformId,
  connectedPlatformIds,
  isPlatformConnected,
} from "../../lib/channels";
import { openExternalUrl } from "../../lib/ipc";
import { notify } from "../../lib/notify";
import { LinearProgress } from "../ui/LinearProgress";
import { Button } from "../ui/Button";
import { PageHeader } from "../layout/PageHeader";
import { Badge } from "../ui/Badge";
import { SectionCard } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Modal } from "../ui/Modal";
import { Field, TextInput } from "../ui/Field";
import { Segmented } from "../ui/Segmented";

const YoutubeIcon = () => (
  <svg className="size-4 fill-current" viewBox="0 0 24 24">
    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
  </svg>
);

const TwitterIcon = () => (
  <svg className="size-4 fill-current" viewBox="0 0 24 24">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const InstagramIcon = () => (
  <svg
    className="size-4 fill-none stroke-current stroke-2"
    viewBox="0 0 24 24"
  >
    <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
    <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
  </svg>
);

const LinkedinIcon = () => (
  <svg className="size-4 fill-current" viewBox="0 0 24 24">
    <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
  </svg>
);

const FacebookIcon = () => (
  <svg className="size-4 fill-current" viewBox="0 0 24 24">
    <path d="M9 8H6v4h3v12h5V12h3.642L18 8h-4V6.333C14 5.374 14.5 5 15.5 5H18V0h-3.8c-3.6 0-5.2 1.8-5.2 4.8V8z" />
  </svg>
);

const TiktokIcon = () => <Share2 className="size-4" />;

/** Channel set shared with the Queue edit modal — single source of truth. */
export const PLATFORMS = [
  { id: "tiktok", name: "TikTok", icon: TiktokIcon },
  { id: "youtube", name: "YouTube Shorts", icon: YoutubeIcon },
  { id: "instagram", name: "Instagram Reels", icon: InstagramIcon },
  { id: "twitter", name: "X / Twitter", icon: TwitterIcon },
  { id: "linkedin", name: "LinkedIn", icon: LinkedinIcon },
  { id: "facebook", name: "Facebook", icon: FacebookIcon },
];

export const TIMEZONES = [
  { id: "Asia/Kolkata", label: "Asia/Kolkata (IST)" },
  { id: "America/New_York", label: "America/New_York (EST)" },
  { id: "America/Los_Angeles", label: "America/Los_Angeles (PST)" },
  { id: "Europe/London", label: "Europe/London (GMT)" },
  { id: "UTC", label: "UTC" },
];

interface SocialPublisherProps {
  apiKey: string;
  onSaveApiKey: (key: string) => Promise<void>;
  onPublish: (apiKey: string, payload: SocialPublishPayload) => Promise<string>;
  onQueueShort: (payload: SocialPublishPayload) => ScheduleItem;
  onGetAccounts?: (apiKey: string) => Promise<ZernioAccount[]>;
  onConnectPlatform?: (apiKey: string, platform: string) => Promise<void>;
  initialVideoPath?: string;
  initialTitle?: string;
  initialDescription?: string;
  initialTags?: string[];
  /** Queue "Open in Social" carries the entry's schedule + channels so
   * nothing is dropped when a queued post is finished here. */
  initialPlatforms?: string[];
  initialScheduledFor?: string;
  initialTimezone?: string;
  /** Finished renders and queued posts the user can load from this page. */
  availableShorts?: SelectableShort[];
  onSelectShort?: (short: SelectableShort) => void;
  /** Dismiss a rendered (not queued) short from history (file kept). */
  onDismissShortOutput?: (outputPath: string) => void;
  /** Delete a queued post from the schedule (confirm first, in-chooser). */
  onDeleteQueuedShort?: (queueId: string) => void;
  onClearShort?: () => void;
  onOpenStudio?: () => void;
  onOpenQueue?: () => void;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Body of the Post panel when nothing is loaded: pick a short or go make one. */
function ShortChooser({
  shorts,
  onSelect,
  onDismissOutput,
  onDeleteQueued,
  onOpenStudio,
  onOpenQueue,
}: {
  shorts: SelectableShort[];
  onSelect?: (short: SelectableShort) => void;
  /** Instant dismiss for rendered rows (history only, file kept). */
  onDismissOutput?: (outputPath: string) => void;
  /** Confirmed delete for queued rows (removes the scheduled post). */
  onDeleteQueued?: (queueId: string) => void;
  onOpenStudio?: () => void;
  onOpenQueue?: () => void;
}) {
  // Queued rows delete the scheduled post, so they confirm first — same
  // pattern as the Queue page. Rendered rows dismiss instantly (file kept),
  // matching the Jobs drawer and the Ready-to-queue list.
  const [shortToDelete, setShortToDelete] =
    useState<SelectableShort | null>(null);
  if (shorts.length === 0) {
    return (
      <EmptyState
        icon={<Film />}
        title="No short to publish"
        description="Render a short in Studio, or add a finished file from Queue. It shows up here so you can pick channels and send it."
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onOpenStudio && (
              <Button variant="primary" onClick={onOpenStudio}>
                Open Studio
              </Button>
            )}
            {onOpenQueue && (
              <Button variant="secondary" onClick={onOpenQueue}>
                Open Queue
              </Button>
            )}
          </div>
        }
      />
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        Choose a short to publish now or schedule.
      </p>
      <ul className="divide-y divide-separator overflow-hidden rounded-md border border-border">
        {shorts.map((short) => {
          const name = fileNameOf(short.videoPath);
          const isQueued = short.source === "queue";
          const canDismiss = isQueued ? !!onDeleteQueued : !!onDismissOutput;
          return (
            <li
              key={`${short.source}:${short.id}`}
              className="flex items-center gap-1 px-3 py-2.5 transition-colors hover:bg-surface-secondary"
            >
              <button
                type="button"
                onClick={() => onSelect?.(short)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-label={`Load ${short.title} for posting`}
              >
                <span className="flex h-9 w-[20px] shrink-0 items-center justify-center rounded-[3px] border border-border bg-surface-tertiary text-muted">
                  <Film className="size-3" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {short.title}
                  </span>
                  <span
                    className="block truncate font-mono text-xs text-muted"
                    title={short.videoPath}
                  >
                    {name}
                  </span>
                </span>
                <Badge variant={isQueued ? "warning" : "success"}>
                  {isQueued ? "In queue" : "Rendered"}
                </Badge>
              </button>
              {canDismiss && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<X />}
                  onClick={() =>
                    isQueued
                      ? setShortToDelete(short)
                      : onDismissOutput?.(short.videoPath)
                  }
                  aria-label={
                    isQueued ? `Delete queued ${name}` : `Dismiss ${name}`
                  }
                  title={
                    isQueued
                      ? "Delete queued post"
                      : "Dismiss from history (file stays on disk)"
                  }
                  className={`size-7 shrink-0 text-muted hover:text-foreground ${isQueued ? "hover:text-danger" : ""}`}
                />
              )}
            </li>
          );
        })}
      </ul>

      <Modal
        isOpen={!!shortToDelete}
        onClose={() => setShortToDelete(null)}
        size="sm"
        icon={<Trash2 className="size-4" />}
        title="Delete queued post"
        description="This permanently removes the post from the schedule queue. The video file stays on disk."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShortToDelete(null)}>
              Keep in queue
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (shortToDelete && onDeleteQueued) {
                  onDeleteQueued(shortToDelete.id);
                }
                setShortToDelete(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        {shortToDelete && (
          <div className="space-y-1 rounded-md border border-border bg-surface-secondary p-3">
            <div className="text-sm font-semibold text-foreground">
              {shortToDelete.title}
            </div>
            <div className="truncate font-mono text-xs text-muted">
              {fileNameOf(shortToDelete.videoPath)}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export const SocialPublisher: React.FC<SocialPublisherProps> = ({
  apiKey,
  onSaveApiKey,
  onPublish,
  onQueueShort,
  onGetAccounts,
  onConnectPlatform,
  initialVideoPath = "",
  initialTitle,
  initialDescription,
  initialTags,
  initialPlatforms,
  initialScheduledFor,
  initialTimezone,
  availableShorts = [],
  onSelectShort,
  onDismissShortOutput,
  onDeleteQueuedShort,
  onClearShort,
  onOpenStudio,
  onOpenQueue,
}) => {
  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey);
  const [savingKey, setSavingKey] = useState(false);
  useEffect(() => setApiKeyDraft(apiKey), [apiKey]);
  // Nothing is pre-selected except a Queue "Open in Social" carry-over:
  // selection otherwise only ever comes from linked accounts.
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(
    initialPlatforms ? [...initialPlatforms] : [],
  );
  // Studio and Queue own the short's metadata; Social only distributes it.
  const title = initialTitle ?? "";
  const description = initialDescription ?? "";
  const videoPath = initialVideoPath;
  const tags = initialTags ?? [];
  const hasShort = Boolean(videoPath.trim() && title.trim());
  const shortHint = "Choose a short on this page, send one from Studio, or open one from Queue.";
  // A carried-over queue schedule starts in Schedule mode with its slot
  // prefilled; everything else starts as publish-now.
  const [publishNow, setPublishNow] = useState(!initialScheduledFor);
  const [scheduledDate, setScheduledDate] = useState(
    () => splitSchedule(initialScheduledFor).date,
  );
  const [scheduledTime, setScheduledTime] = useState(
    () => splitSchedule(initialScheduledFor).time,
  );
  const [timezone, setTimezone] = useState(
    initialTimezone ?? DEFAULT_TIMEZONE,
  );

  const [accounts, setAccounts] = useState<ZernioAccount[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(
    null,
  );
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStage, setSubmitStage] = useState<string>("Validating media");
  const reportError = (message: string) => notify("Couldn’t complete the request", message, "error");

  const connectedIds = connectedPlatformIds(accounts);

  useEffect(() => {
    if (apiKey.trim()) {
      loadAccounts();
    } else {
      // Key removed: drop everything so no stale links stay visible.
      setAccounts([]);
      setSelectedPlatforms([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  const handleOpenPortal = async () => {
    try {
      await openExternalUrl("https://zernio.com/app/accounts");
    } catch (err: unknown) {
      notify(
        "Couldn't open browser",
        err instanceof Error ? err.message : "https://zernio.com/app/accounts",
        "error",
      );
    }
  };

  const loadAccounts = async () => {
    if (!onGetAccounts || !apiKey.trim()) return;
    setIsLoadingAccounts(true);
    try {
      const list = await onGetAccounts(apiKey.trim());
      setAccounts(list);

      const connected = connectedPlatformIds(list);
      setSelectedPlatforms((prev) =>
        prev.length === 0
          ? connected
          : prev.filter((p) => connected.includes(p.toLowerCase())),
      );
    } catch (e) {
      console.error("Failed to load accounts:", e);
      reportError(
        `Couldn't sync accounts: ${e instanceof Error ? e.message : "gateway request failed"} — check the API key and try again.`,
      );
    } finally {
      setIsLoadingAccounts(false);
    }
  };

  const handleConnect = async (platformId: string) => {
    if (!onConnectPlatform || !apiKey.trim()) return;
    setConnectingPlatform(platformId);
    try {
      await onConnectPlatform(apiKey.trim(), platformId);
    } finally {
      setConnectingPlatform(null);
    }
  };

  const togglePlatform = (id: string) => {
    if (!connectedIds.includes(id.toLowerCase())) return;
    setSelectedPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  };

  const handleSelectAll = () => {
    setSelectedPlatforms((prev) =>
      prev.length === connectedIds.length && connectedIds.length > 0
        ? []
        : [...connectedIds],
    );
  };


  // Schedule mode queues locally: no key or linked channels required.
  // Channels can be picked now (when linked) or later via Queue → Edit.
  const canQueueLocal =
    hasShort &&
    scheduledDate.trim().length > 0 &&
    (connectedIds.length === 0 || selectedPlatforms.length > 0);

  const queueHint = !hasShort
    ? shortHint
    : !scheduledDate
      ? "Pick a release date first"
      : connectedIds.length > 0 && selectedPlatforms.length === 0
        ? "Select at least one channel"
        : undefined;

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!hasShort) {
      reportError(shortHint);
      return;
    }

    // Every selected platform needs a linked account id — never send the
    // platform slug itself (the gateway rejects it with a 400).
    const unlinked = selectedPlatforms.filter(
      (p) =>
        !accounts.some(
          (a) =>
            a.is_connected &&
            canonicalPlatformId(a.platform) === canonicalPlatformId(p),
        ),
    );
    if (unlinked.length > 0) {
      reportError(
        `No linked account for ${unlinked.join(", ")} — sync accounts and try again.`,
      );
      setSelectedPlatforms((prev) =>
        prev.filter(
          (p) =>
            !unlinked.some((u) => u.toLowerCase() === p.toLowerCase()),
        ),
      );
      return;
    }
    const targetAccountIds = selectedPlatforms.map((p) => {
      const acc = accounts.find(
        (a) =>
          a.is_connected &&
          canonicalPlatformId(a.platform) === canonicalPlatformId(p),
      );
      return acc ? acc.id : p;
    });

    const payload: SocialPublishPayload = {
      title,
      description,
      platforms: selectedPlatforms,
      video_path: videoPath,
      publish_now: publishNow,
      scheduled_for:
        !publishNow && scheduledDate
          ? `${scheduledDate}T${scheduledTime}:00`
          : undefined,
      timezone,
      account_ids: targetAccountIds,
      tags,
    };

    // Schedule → local queue entry, always visible on the Queue page.
    if (!publishNow) {
      if (!canQueueLocal) {
        reportError(queueHint ?? "Complete the schedule form first.");
        return;
      }
      onQueueShort(payload);
      return;
    }

    if (selectedPlatforms.length === 0) {
      reportError("Please select at least one social media channel.");
      return;
    }
    if (!apiKey.trim()) {
      reportError("Zernio API Key is required to publish or schedule posts.");
      setShowApiKeyInput(true);
      return;
    }
    const stale = selectedPlatforms.filter(
      (p) => !connectedIds.includes(p.toLowerCase()),
    );
    if (stale.length > 0) {
      reportError(
        "Selected channels are no longer connected. Sync accounts and try again.",
      );
      setSelectedPlatforms((prev) =>
        prev.filter((p) => connectedIds.includes(p.toLowerCase())),
      );
      return;
    }

    setIsSubmitting(true);
    setSubmitStage("Preparing media payload...");


    try {
      setSubmitStage("Connecting to Zernio REST Gateway...");
      await new Promise((r) => setTimeout(r, 250));

      setSubmitStage(`Dispatching to ${selectedPlatforms.join(", ")}...`);
      await onPublish(apiKey, payload);
    } catch {
      // The app owns publishing notifications, including partial gateway failures.
    } finally {
      setIsSubmitting(false);
    }
  };

  const connectedCount = accounts.filter((a) => a.is_connected).length;
  const videoName = videoPath.split(/[\\/]/).pop() || videoPath;
  const submitDisabled =
    isSubmitting ||
    !hasShort ||
    (publishNow
      ? !canDispatch(apiKey, selectedPlatforms, accounts)
      : !canQueueLocal);
  const submitHint = !hasShort
    ? shortHint
    : publishNow
      ? !apiKey.trim()
        ? "Add your Zernio API key to publish"
        : selectedPlatforms.length === 0
          ? "Link and select at least one channel"
          : `Publishing to ${selectedPlatforms.length} channel${selectedPlatforms.length === 1 ? "" : "s"}`
      : (queueHint ?? "Adds the post to the Queue page");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Social"
        description={
          <>
            <span className="font-medium text-foreground">{connectedCount}</span>{" "}
            of {PLATFORMS.length} channels connected
            {apiKey.trim() ? "" : " · API key required"}
          </>
        }
        actions={
          <>
          <Button
            variant="secondary"
            icon={<Key />}
            onClick={() => setShowApiKeyInput(!showApiKeyInput)}
            aria-expanded={showApiKeyInput}
          >
            {apiKey.trim() ? "API key" : "Add API key"}
            <ChevronDown
              className={`size-3.5 text-muted transition-transform ${showApiKeyInput ? "rotate-180" : ""}`}
            />
          </Button>
          <Button
            variant="secondary"
            isLoading={isLoadingAccounts}
            icon={<RefreshCw />}
            onClick={loadAccounts}
            disabled={!apiKey.trim()}
          >
            Sync
          </Button>
          <Button
            variant="ghost"
            icon={<ExternalLink />}
            onClick={handleOpenPortal}
          >
            Zernio
          </Button>
          </>
        }
      />

      {/* API key panel */}
      {showApiKeyInput && (
        <div className="flex flex-col gap-2 rounded-3xl bg-surface shadow-surface p-4 sm:flex-row sm:items-center">
          <div className="min-w-0 sm:w-56">
            <div className="text-sm font-medium text-foreground">
              Zernio API key
            </div>
            <div className="text-xs text-muted">
              Used to publish and sync channels
            </div>
          </div>
          <TextInput
            type="password"
            placeholder="zr_live_…"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            className="font-mono text-sm"
            aria-label="Zernio API key"
          />
          <Button isLoading={savingKey} onClick={async () => {
            setSavingKey(true);
            try { await onSaveApiKey(apiKeyDraft.trim()); }
            catch (error) { reportError(String(error)); }
            finally { setSavingKey(false); }
          }}>Save key</Button>
          {apiKey.trim() ? (
            <Badge variant="success" dot className="shrink-0">
              Active
            </Badge>
          ) : (
            <Badge variant="warning" className="shrink-0">
              Required
            </Badge>
          )}
        </div>
      )}

      <form
        onSubmit={handlePublish}
        className={`social-layout grid grid-cols-1 gap-6 ${hasShort ? "items-start" : ""}`}
      >
        {/* Post */}
        <SectionCard
          title="Post"
          description={
            hasShort
              ? "Title, description and tags come from Studio or Queue"
              : availableShorts.length > 0
                ? "Select a short to publish or schedule"
                : "Nothing to publish yet"
          }
          actions={
            hasShort && onClearShort ? (
              <Button variant="ghost" size="sm" onClick={onClearShort}>
                Change
              </Button>
            ) : undefined
          }
          footer={
            hasShort ? (
              <div className="flex w-full flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-muted">{submitHint}</span>
                <Button
                  type="submit"
                  variant="primary"
                  isLoading={isSubmitting}
                  disabled={submitDisabled}
                  title={submitHint}
                  icon={publishNow ? <Send /> : <Clock />}
                >
                  {publishNow
                    ? `Publish to ${selectedPlatforms.length} channel${selectedPlatforms.length === 1 ? "" : "s"}`
                    : "Add to queue"}
                </Button>
              </div>
            ) : undefined
          }
        >
          {!hasShort ? (
            <ShortChooser
              shorts={availableShorts}
              onSelect={onSelectShort}
              onDismissOutput={onDismissShortOutput}
              onDeleteQueued={onDeleteQueuedShort}
              onOpenStudio={onOpenStudio}
              onOpenQueue={onOpenQueue}
            />
          ) : (
            <div className="space-y-5">
              <div className="flex gap-3.5">
                <span className="flex h-20 w-[45px] shrink-0 items-center justify-center rounded-md border border-border bg-surface-tertiary text-muted">
                  <Film className="size-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="text-sm leading-snug font-semibold break-words text-foreground">
                    {title}
                  </p>
                  <p
                    className="truncate font-mono text-xs text-muted"
                    title={videoPath}
                  >
                    {videoName}
                  </p>
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {tags.slice(0, 8).map((tag) => (
                        <Badge key={tag} variant="neutral">
                          {tag}
                        </Badge>
                      ))}
                      {tags.length > 8 && (
                        <span className="text-xs text-muted">
                          +{tags.length - 8}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-3 border-t border-separator pt-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      When
                    </div>
                    <div className="text-xs text-muted">
                      {publishNow
                        ? "Goes out as soon as you publish"
                        : "Saved to the Queue for the time below"}
                    </div>
                  </div>
                  <Segmented
                    label="Distribution timing"
                    value={publishNow ? "now" : "later"}
                    onChange={(v) => setPublishNow(v === "now")}
                    options={[
                      { value: "now", label: "Publish now" },
                      { value: "later", label: "Schedule" },
                    ]}
                  />
                </div>
                {!publishNow && (
                  <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
                    <Field label="Date">
                      <TextInput
                        type="date"
                        value={scheduledDate}
                        onChange={(e) => setScheduledDate(e.target.value)}
                        required={!publishNow}
                        aria-label="Release date"
                      />
                    </Field>
                    <Field label="Time">
                      <TextInput
                        type="time"
                        value={scheduledTime}
                        onChange={(e) => setScheduledTime(e.target.value)}
                        required={!publishNow}
                        aria-label="Release time"
                      />
                    </Field>
                    <Field label="Timezone">
                      <Select
                        variant="secondary"
                        selectedKey={timezone}
                        onSelectionChange={(key) => setTimezone(String(key))}
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
                    </Field>
                  </div>
                )}
              </div>

              {isSubmitting && (
                <div className="space-y-2 rounded-md border border-border bg-surface-secondary p-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <Spinner size="sm" color="current" />
                    {submitStage}
                  </div>
                  <LinearProgress label="Publishing" />
                </div>
              )}
            </div>
          )}
        </SectionCard>

        {/* Channels */}
        <SectionCard
          className={hasShort ? "lg:sticky lg:top-0" : undefined}
          title="Channels"
          description={`${selectedPlatforms.length} selected`}
          actions={
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSelectAll}
              disabled={connectedIds.length === 0}
            >
              {selectedPlatforms.length === connectedIds.length &&
              connectedIds.length > 0
                ? "Clear"
                : "Select all"}
            </Button>
          }
        >
          <ul className="space-y-px">
            {PLATFORMS.map((platform) => {
              const Icon = platform.icon;
              const isSelected = selectedPlatforms.includes(platform.id);
              const acc = accounts.find(
                (a) =>
                  a.is_connected &&
                  canonicalPlatformId(a.platform) === platform.id,
              );
              const isConnected = isPlatformConnected(accounts, platform.id);
              const isConnecting = connectingPlatform === platform.id;

              const glyph = (
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-md border ${
                    isConnected
                      ? "border-border bg-surface-secondary text-foreground"
                      : "border-dashed border-border text-muted"
                  }`}
                >
                  <Icon />
                </span>
              );

              if (!isConnected) {
                return (
                  <li
                    key={platform.id}
                    className="flex items-center -mx-2 gap-3 rounded-xl px-2 py-2"
                  >
                    {glyph}
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="truncate text-sm font-medium text-foreground">
                        {platform.name}
                      </div>
                      <div className="text-xs text-muted">Not linked</div>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      isLoading={isConnecting}
                      disabled={isConnecting || !apiKey.trim()}
                      title={!apiKey.trim() ? "Add your Zernio API key first" : undefined}
                      onClick={() => handleConnect(platform.id)}
                    >
                      {isConnecting ? "Linking" : "Link"}
                    </Button>
                  </li>
                );
              }

              return (
                <li key={platform.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    onClick={() => togglePlatform(platform.id)}
                    className={`flex w-full items-center -mx-2 gap-3 rounded-xl px-2 py-2 text-left transition-colors ${
                      isSelected ? "bg-accent/8" : "hover:bg-surface-secondary"
                    }`}
                  >
                    {glyph}
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {platform.name}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {acc ? accountLabel(acc) : "Connected"}
                      </span>
                    </span>
                    <span
                      className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
                        isSelected
                          ? "border-accent bg-accent text-accent-foreground"
                          : "border-border-tertiary text-transparent"
                      }`}
                    >
                      <Check className="size-3" strokeWidth={3.5} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      </form>
    </div>
  );
};
