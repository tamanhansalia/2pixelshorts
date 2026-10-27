import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as ipc from "./lib/ipc";
import {
  extractPostId,
  mapRemoteStatus,
  platformFailureMessage,
  postStatusOf,
} from "./lib/channels";
import {
  buildSeoPatch,
  canPostItem,
  clearCompletedItems,
  dueDispatchIds,
  findQueueItemByVideoPath,
  formatScheduledLabel,
  markDispatched,
  markDispatchFailed,
  markDispatching,
  recoverStuckPublishing,
  newScheduleItem,
  queuePayloadForOutput,
  removeQueueItem,
  selectableShorts,
  toPublishPayload,
  unqueuedOutputs,
  type OutputSeo,
  type QueueSeoPatch,
  type SelectableShort,
} from "./lib/outbox";
import {
  cancelJob,
  getJobStatus,
  listenRenderFinished,
  listenRenderProgress,
} from "./lib/jobs";
import {
  activeRenderJobs,
  applyFinishedToHistory,
  applyProgressToHistory,
  createRenderHistoryEntry,
  dismissOutputFromHistory,
  isActiveRenderStatus,
  loadRenderHistory,
  pushHistoryEntry,
  saveRenderHistory,
  type RenderHistoryEntry,
} from "./lib/renderHistory";
import { renderWarningsFor } from "./lib/jobs";
import { notify } from "./lib/notify";
import { buildStorageScope, recordsAfterCleanup, type StorageDeleteReport } from "./lib/storage";
import { isBusyClipJob } from "./lib/streamAnalysis";
import { useStreamAnalysis } from "./lib/useStreamAnalysis";
import { useLiveWatcher } from "./lib/useLiveWatcher";
import { streamSuggestOptions } from "./lib/streamClips";
import { createLatestGuard } from "./lib/asyncLatest";
import { loadTranscriptionProvider, saveTranscriptionProvider, type TranscriptionProvider } from "./lib/transcription";
import { clearApiKeys, loadApiKeys, saveApiKey, type CredentialProvider } from "./lib/credentials";
import { MotionConfig } from "framer-motion";
import { useTheme } from "@heroui/react";
import { ColorMode, NavTab, Sidebar } from "./components/layout/Sidebar";
import {
  applyStudioSeo,
  buildDraftFromQueue,
  buildSourceEntries,
  importClipDrafts,
  loadStudioStore,
  preferredSeoAgent,
  removeSource,
  saveStudioStore,
  selectSource,
  upsertDraft,
  type SourceEntry,
  type StudioProjectDraft,
} from "./lib/studioProjects";
import {
  failSeoJob,
  finishSeoJob,
  startSeoJob,
  type StudioSeoJobs,
} from "./lib/seoJobs";
import {
  loadStreamRunStore,
  removeStreamRun,
  saveStreamRunStore,
  streamSidebarItems,
} from "./lib/streamRuns";
import {
  resetAllLocalData,
  SCHEDULE_QUEUE_KEY,
} from "./lib/appReset";
import { LinearProgress } from "./components/ui/LinearProgress";
import { StatusBar } from "./components/layout/StatusBar";
import { RenderJobsDrawer } from "./components/jobs/RenderJobsDrawer";
import { VideoStudio, type RenderJobUpdate } from "./components/studio/VideoStudio";
import {
  getDefaultProfileId,
  getEffectiveContext,
  loadProfiles,
  saveProfiles,
  setDefaultProfileId,
  type ChannelProfile,
} from "./lib/channelProfiles";
import { SocialPublisher } from "./components/social/SocialPublisher";
import { ScheduleQueue, type QueueItemPatch } from "./components/scheduler/ScheduleQueue";
import { PerformanceView } from "./components/performance/PerformanceView";
import { usePostPerformance } from "./lib/usePostPerformance";
import {
  SettingsView,
  SettingsSubTab,
} from "./components/settings/SettingsView";
import { AppToasts } from "./components/ui/Toast";
import {
  CliToolInfo,
  CommandOutput,
  VideoMetadata,
  SocialPublishPayload,
  ScheduleItem,
  GlobalTaskStatus,
  SeoMetadata,
  TranscriptionStatus,
  ZernioAccount,
} from "./types";

export function App() {
  const { theme, setTheme } = useTheme("light");
  const colorMode = (theme === "light" || theme === "system" ? theme : "dark") as ColorMode;

  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const hash = window.location.hash.replace("#", "");
    if (hash.startsWith("settings")) {
      return "settings";
    }
    if (["studio", "social", "scheduler", "performance"].includes(hash)) {
      return hash as NavTab;
    }
    return "studio";
  });
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsSubTab>(() => {
    const hash = window.location.hash.replace("#", "");
    if (hash === "settings-themes" || hash === "settings-appearance")
      return "appearance";
    if (hash === "settings-keys") return "keys";
    if (hash === "settings-channel") return "channel";
    if (hash === "settings-engine") return "engine";
    if (hash === "settings-storage") return "storage";
    return "clis";
  });

  useEffect(() => {
    window.location.hash = activeTab;
  }, [activeTab]);

  const [tools, setTools] = useState<CliToolInfo[]>([]);
  const [isLoadingClis, setIsLoadingClis] = useState(false);
  const [globalTask, setGlobalTask] = useState<GlobalTaskStatus>({
    type: "idle",
  });
  // Transcription readiness behind analysis/captions; refreshed with the
  // key so the Queue card can warn before a doomed Analyze run. The probe
  // effect lives below, next to the ElevenLabs key state it depends on.
  const [transcription, setTranscription] =
    useState<TranscriptionStatus | null>(null);
  // Render-job history: recorded on start, updated from the global
  // progress/finished events so renders stay visible across tab switches.
  const [renderHistory, setRenderHistory] = useState<RenderHistoryEntry[]>(() =>
    loadRenderHistory(),
  );
  const [isJobsOpen, setIsJobsOpen] = useState(false);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  useEffect(() => {
    saveRenderHistory(renderHistory);
  }, [renderHistory]);

  // Studio sources: each imported video keeps its edit state + SEO, listed
  // in the sidebar. Selecting one reopens Studio on its Metadata step.
  const [studioStore, setStudioStore] = useState(() => loadStudioStore());
  const [draftLoadKey, setDraftLoadKey] = useState(0);
  const [studioBlankKey, setStudioBlankKey] = useState(0);
  // Analyzed stream links live here (not in the file-keyed studio
  // store), so clips survive tab switches and appear in the sidebar.
  const [streamRuns, setStreamRuns] = useState(loadStreamRunStore);
  const { jobs: streamAnalysisJobs, startAnalysis, isRunning: isStreamRunning, dismissJob: dismissStreamJob, stopWatching: stopWatchingStream } = useStreamAnalysis(setStreamRuns, streamRuns);
  const runningClipJobs = Object.values(streamAnalysisJobs).filter((job) => job.status === "running");
  const watchingClipJobs = Object.values(streamAnalysisJobs).filter((job) => job.status === "watching");
  const activeClipJobs = Object.values(streamAnalysisJobs).filter(isBusyClipJob);
  const clipActivity = Object.values(streamAnalysisJobs).map((job) => ({
    ...job,
    title: streamRuns.runs[job.url]?.probe?.title || streamRuns.runs[job.url]?.result?.title || job.url,
  }));
  const streamOpenSequence = useRef(0);
  const [selectedStreamUrl, setSelectedStreamUrl] = useState<string | null>(null);
  const [pendingStream, setPendingStream] = useState<{
    url: string;
    key: number;
  } | null>(null);
  /** Plus asked for an empty Studio; stays until a file or stream is chosen. */
  const [startBlankStudio, setStartBlankStudio] = useState(false);

  useEffect(() => {
    saveStreamRunStore(streamRuns);
  }, [streamRuns]);

  const streamItems = useMemo(
    () => streamSidebarItems(streamRuns),
    [streamRuns],
  );

  useEffect(() => {
    saveStudioStore(studioStore);
  }, [studioStore]);

  const handleDraftChange = useCallback((draft: StudioProjectDraft) => {
    if (draft.inputPath.trim()) setStartBlankStudio(false);
    setStudioStore((prev) => {
      if (!draft.inputPath.trim()) return prev;
      const next = upsertDraft(prev, draft);
      return {
        ...next,
        recent: next.recent.includes(draft.inputPath)
          ? next.recent
          : [draft.inputPath, ...next.recent],
        currentId: draft.inputPath,
      };
    });
  }, []);

  const currentDraft = studioStore.currentId
    ? (studioStore.projects[studioStore.currentId] ?? null)
    : null;

  useEffect(() => {
    let disposed = false;
    let unProgress: (() => void) | null = null;
    let unFinished: (() => void) | null = null;
    listenRenderProgress((p) => {
      if (disposed) return;
      setRenderHistory((prev) => applyProgressToHistory(prev, p));
    }).then((fn) => {
      if (disposed) fn();
      else unProgress = fn;
    });
    listenRenderFinished((info) => {
      if (disposed) return;
      setRenderHistory((prev) => applyFinishedToHistory(prev, info));
      // The Studio view toasts its own completion; only toast here when
      // the user is looking at another tab.
      if (activeTabRef.current !== "studio") {
        if (info.status === "completed" && info.result?.success) {
          const warnings = renderWarningsFor(info.result);
          if (warnings.length) notify("Short rendered with warnings", warnings.map(w => [w.message, w.detail].filter(Boolean).join(" — ")).join("\n"), "warning");
          else notify("Short rendered", `Output saved to ${info.output_video}`, "success");
        } else if (info.status === "cancelled") {
          notify("Render cancelled", "The background job was stopped", "info");
        } else {
          notify("Render failed", info.error || "Render process finished with error code.", "error");
        }
      }
    }).then((fn) => {
      if (disposed) fn();
      else unFinished = fn;
    });
    return () => {
      disposed = true;
      unProgress?.();
      unFinished?.();
    };
  }, []);

  const handleRenderStarted = (
    jobId: string,
    params: {
      input_video: string;
      output_video: string;
      preset_id: string;
      agent_id?: string;
      meta_title?: string;
      meta_desc?: string;
      meta_tags?: string[];
    },
  ) => {
    const hasSeo = Boolean(
      params.meta_title?.trim() ||
        params.meta_desc?.trim() ||
        (params.meta_tags?.length ?? 0) > 0,
    );
    setRenderHistory((prev) =>
      pushHistoryEntry(
        prev,
        createRenderHistoryEntry(
          jobId,
          params,
          hasSeo
            ? {
                title: params.meta_title?.trim() ?? "",
                description: params.meta_desc ?? "",
                tags: params.meta_tags ? [...params.meta_tags] : [],
              }
            : undefined,
        ),
      ),
    );
    // A very fast failure can emit its finished event before the new history
    // entry reaches the frontend. Reconcile after insertion so it cannot
    // remain queued forever after that event was missed.
    void getJobStatus(jobId).then((info) => {
      if (info.status === "completed" || info.status === "failed" || info.status === "cancelled") {
        setRenderHistory((prev) => applyFinishedToHistory(prev, info));
      }
    }).catch(() => {});
  };

  const handleCancelRenderJob = async (id: string) => {
    try {
      await cancelJob(id);
    } catch (err: unknown) {
      notify(
        "Cancel failed",
        err instanceof Error ? err.message : "Could not cancel render job",
        "error",
      );
    }
  };

  const handleDismissRenderJob = (id: string) => {
    setRenderHistory((prev) => prev.filter((j) => j.id !== id));
  };

  // Dismiss a "Ready to queue" output from the Queue page: drops its
  // finished history entries so the row disappears. Same data removal as
  // the Jobs drawer's Dismiss — the video file stays on disk and can be
  // re-queued anytime via Add a video.
  const handleDismissOutput = useCallback((outputPath: string) => {
    setRenderHistory((prev) => dismissOutputFromHistory(prev, outputPath));
  }, []);

  const handleClearFinishedRenders = () => {
    setRenderHistory((prev) => prev.filter((j) => isActiveRenderStatus(j.status)));
  };

  const activeRenders = activeRenderJobs(renderHistory);
  const latestRender = activeRenders[0] ?? null;

  // Keep the app-wide task indicator in sync with render history even when
  // the Studio view (which also mirrors progress) is unmounted.
  useEffect(() => {
    if (latestRender) {
      setGlobalTask((prev) => {
        if (
          prev.type === "rendering" &&
          prev.label === latestRender.stage &&
          prev.progress === latestRender.progress
        ) {
          return prev;
        }
        if (prev.type !== "idle" && prev.type !== "rendering") return prev;
        return {
          type: "rendering",
          label: latestRender.stage || "Rendering short",
          progress: latestRender.progress,
        };
      });
    } else {
      setGlobalTask((prev) =>
        prev.type === "rendering" ? { type: "idle" } : prev,
      );
    }
  }, [latestRender]);

  const [zernioKey, setZernioKey] = useState("");
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  const [transcriptionProvider, setTranscriptionProvider] = useState<TranscriptionProvider>(loadTranscriptionProvider);
  const handleTranscriptionProviderChange = (provider: TranscriptionProvider) => {
    try {
      saveTranscriptionProvider(provider);
      setTranscriptionProvider(provider);
    } catch { notify("Could not save transcription provider", "Check local storage access and retry.", "error"); }
  };
  const [youtubeKey, setYoutubeKey] = useState("");
  const [credentialsReady, setCredentialsReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    loadApiKeys().then((keys) => {
      if (disposed) return;
      setZernioKey(keys.zernio);
      setElevenLabsKey(keys.elevenlabs);
      setYoutubeKey(keys.youtube);
      setCredentialsReady(true);
    }).catch((error) => {
      if (!disposed) notify("Could not load API keys", String(error), "error");
    });
    return () => { disposed = true; };
  }, []);

  // Same stale-probe guard as Settings: a slow probe with the previous key
  // must not overwrite the newer post-save result (Queue card would warn
  // about a missing transcript even though the key was just saved).
  const transcriptionGuardRef = useRef(createLatestGuard());
  useEffect(() => {
    const requestId = transcriptionGuardRef.current.next();
    let disposed = false;
    ipc
      .probeTranscription(elevenLabsKey, transcriptionProvider)
      .then((status) => {
        if (!disposed && transcriptionGuardRef.current.isLatest(requestId)) {
          setTranscription(status);
        }
      })
      .catch(() => {
        if (!disposed && transcriptionGuardRef.current.isLatest(requestId)) {
          setTranscription(null);
        }
      });
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elevenLabsKey, transcriptionProvider]);

  useLiveWatcher(
    streamRuns,
    setStreamRuns,
    isStreamRunning,
    startAnalysis,
    (run) => ({
      ...streamSuggestOptions({ agentId: run.agent, length: run.length }),
      elevenlabsKey: elevenLabsKey,
      transcriptionProvider,
    }),
  );

  const [channelProfiles, setChannelProfiles] = useState<ChannelProfile[]>(() => {
    return loadProfiles();
  });
  const [defaultChannelId, setDefaultChannelIdState] = useState<string | null>(() => {
    return getDefaultProfileId();
  });
  const [publishedVideoPath, setPublishedVideoPath] =
    useState<string>("");
  const [publishedMetadata, setPublishedMetadata] = useState<{
    title?: string;
    description?: string;
    tags?: string[];
  }>({});
  // Queue "Open in Social" carry-over: the entry's release slot + channels
  // so Social starts from the queued values instead of dropping them.
  const [publishedSchedule, setPublishedSchedule] = useState<{
    scheduled_for?: string;
    timezone?: string;
    platforms?: string[];
  }>({});

  // Scheduled Posts Queue
  const [queue, setQueue] = useState<ScheduleItem[]>(() => {
    const saved = localStorage.getItem(SCHEDULE_QUEUE_KEY);
    if (saved) {
      try {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          // A reload never resumes an in-flight dispatch: rows still
          // marked `publishing` in storage are stale, so return them to
          // `queued` instead of stranding them without row actions.
          return recoverStuckPublishing(parsed as ScheduleItem[]);
        }
      } catch {
        // Corrupt storage falls through to empty.
      }
    }
    return [];
  });
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const zernioKeyRef = useRef(zernioKey);
  zernioKeyRef.current = zernioKey;

  // Published-post metrics: the SEO feedback loop (winning titles steer
  // every new analysis; see lib/performance).
  const postPerformance = usePostPerformance(queue, zernioKey);

  // Save queue on change
  useEffect(() => {
    localStorage.setItem(SCHEDULE_QUEUE_KEY, JSON.stringify(queue));
  }, [queue]);

  // Sidebar entries: one merged row per short (source + linked output),
  // with live status. Queue-only outputs stand alone.
  const sidebarEntries: SourceEntry[] = useMemo(
    () =>
      buildSourceEntries(
        studioStore.recent,
        studioStore.projects,
        renderHistory,
        queue,
      ),
    [studioStore.recent, studioStore.projects, renderHistory, queue],
  );

  const handleSelectSource = useCallback(
    (id: string) => {
      setStartBlankStudio(false);
      setSelectedStreamUrl(null);
      setPendingStream(null);
      setStudioStore((prev) => {
        const existing = prev.projects[id];
        const queued = queue.find((q) => q.video_path === id);
        const draft: StudioProjectDraft =
          existing ?? buildDraftFromQueue(queued ?? { video_path: id, title: "" });
        // Sidebar selection reopens the same single Studio page; the
        // draft's saved settings are restored as-is, in flow order.
        const landed = { ...draft, inputPath: id };
        return selectSource(upsertDraft(prev, landed), id);
      });
      setDraftLoadKey((k) => k + 1);
      setActiveTab("studio");
    },
    [queue],
  );

  // Start a brand-new short: remounts Studio blank (source step) without
  // touching the saved sources or stream library. Clip jobs and renders
  // keep running in the sidebar / jobs dialog.
  const handleNewSource = useCallback(() => {
    setStartBlankStudio(true);
    setSelectedStreamUrl(null);
    setPendingStream(null);
    setStudioStore((prev) => ({ ...prev, currentId: null }));
    setStudioBlankKey((k) => k + 1);
    setActiveTab("studio");
  }, []);

  // Open a saved stream run: Studio restores its clips on arrival.
  const handleSelectStream = useCallback((url: string) => {
    setStartBlankStudio(false);
    setSelectedStreamUrl(url);
    setPendingStream({ url, key: ++streamOpenSequence.current });
    setActiveTab("studio");
  }, []);

  // Import downloaded stream windows as sidebar sources. Each window is
  // already the short: the draft keeps the whole file and opens on
  // Captions. The first clip opens in Studio; the rest wait in the sidebar.
  const handleImportClipsAsSources = useCallback(
    (clips: { inputPath: string; metadata: StudioProjectDraft["metadata"]; title?: string }[]) => {
      if (clips.every((clip) => !clip.inputPath.trim())) return;
      setStartBlankStudio(false);
      setSelectedStreamUrl(null);
      setStudioStore((prev) => importClipDrafts(prev, clips));
      setDraftLoadKey((k) => k + 1);
      setActiveTab("studio");
    },
    [],
  );

  const handleRemoveStream = useCallback((url: string) => {
    if (isStreamRunning(url)) return;
    const wasOpen = selectedStreamUrl === url;
    setStreamRuns((prev) => removeStreamRun(prev, url));
    stopWatchingStream(url);
    dismissStreamJob(url);
    setPendingStream((prev) => (prev?.url === url ? null : prev));
    setSelectedStreamUrl((prev) => (prev === url ? null : prev));
    if (wasOpen && !studioStore.currentId) {
      setStartBlankStudio(true);
      setStudioBlankKey((k) => k + 1);
    }
  }, [isStreamRunning, stopWatchingStream, dismissStreamJob, selectedStreamUrl, studioStore.currentId]);

  // Remove sidebar rows: drops each row's studio draft plus its linked
  // queue rows, so entries cannot reappear via the queue. Rendering rows
  // are protected — cancel the render first. History stays in the Jobs
  // drawer (dismiss/clear there).
  const removeEntries = useCallback(
    (entries: SourceEntry[]) => {
      const blocked = entries.filter((e) => e.status === "rendering");
      const removable = entries.filter((e) => e.status !== "rendering");
      if (blocked.length > 0) {
        triggerToast(
          "Render in progress",
          blocked.length === entries.length
            ? "Cancel the render before removing this short"
            : `${blocked.length} rendering short${blocked.length === 1 ? " was" : "s were"} skipped — cancel those renders first`,
          "error",
        );
        if (removable.length === 0) return { removed: 0, queued: 0 };
      }
      const projectIds = new Set(
        removable.map((e) => e.projectId).filter((p): p is string => Boolean(p)),
      );
      const queuePaths = new Set(removable.flatMap((e) => e.queuePaths));
      const queuedMatches = queue.filter((q) => queuePaths.has(q.video_path)).length;
      const wasCurrent =
        studioStore.currentId !== null && projectIds.has(studioStore.currentId);
      setStudioStore((prev) => {
        let next = prev;
        for (const pid of projectIds) next = removeSource(next, pid);
        return next;
      });
      if (queuedMatches > 0) {
        setQueue((prev) => prev.filter((q) => !queuePaths.has(q.video_path)));
      }
      if (wasCurrent) {
        setStudioBlankKey((k) => k + 1);
      }
      return { removed: removable.length, queued: queuedMatches };
    },
    [queue, studioStore.currentId],
  );

  const handleRemoveSource = useCallback(
    (id: string) => {
      const entry = sidebarEntries.find((e) => e.id === id);
      if (!entry) return;
      const { queued } = removeEntries([entry]);
      if (entry.status !== "rendering") {
        triggerToast(
          "Removed from sidebar",
          queued > 0
            ? `Short and ${queued} queued post${queued === 1 ? "" : "s"} removed`
            : "Short removed from the sidebar",
          "info",
        );
      }
    },
    [sidebarEntries, removeEntries],
  );

  const handleRemoveSources = useCallback(
    (ids: string[]) => {
      const entries = sidebarEntries.filter((e) => ids.includes(e.id));
      if (entries.length === 0) return;
      const { removed, queued } = removeEntries(entries);
      if (removed > 0) {
        triggerToast(
          `Removed ${removed} short${removed === 1 ? "" : "s"}`,
          queued > 0
            ? `Including ${queued} queued post${queued === 1 ? "" : "s"}`
            : undefined,
          "info",
        );
      }
    },
    [sidebarEntries, removeEntries],
  );

  const triggerToast = (
    title: string,
    description?: string,
    type: "success" | "error" | "info" | "warning" = "info",
  ) => {
    notify(title, description, type);
  };

  const saveCredential = async (provider: CredentialProvider, key: string, setKey: (key: string) => void) => {
    if (!credentialsReady) throw new Error("API keys are still loading. Unlock the system credential store and restart if needed.");
    await saveApiKey(provider, key);
    setKey(key.trim());
  };
  const saveZernioKey = (key: string) => saveCredential("zernio", key, setZernioKey);
  const saveElevenLabsKey = (key: string) => saveCredential("elevenlabs", key, setElevenLabsKey);
  const saveYoutubeKey = (key: string) => saveCredential("youtube", key, setYoutubeKey);

  // Complete local reset: wipe every persisted key, then reload so all
  // state re-initializes from empty (API keys cleared, queue/history/
  // projects/profiles gone, defaults re-seeded on next launch).
  // Settings > Storage scans the folders these records point at and
  // protects files still rendering or waiting to publish.
  const storageScope = useMemo(
    () => buildStorageScope({ history: renderHistory, studio: studioStore, queue, streamRuns }),
    [renderHistory, studioStore, queue, streamRuns],
  );

  // Files moved to the Trash take their history rows and Studio sources with them.
  const handleStorageCleaned = useCallback(
    (report: StorageDeleteReport) => {
      if (report.removed_files.length === 0) return;
      const next = recordsAfterCleanup(renderHistory, studioStore, report.removed_files);
      if (next.history !== renderHistory) setRenderHistory(next.history);
      if (next.removedSources.length > 0) {
        setStudioStore(next.studio);
        if (studioStore.currentId && next.removedSources.includes(studioStore.currentId)) {
          setStudioBlankKey((k) => k + 1);
        }
      }
    },
    [renderHistory, studioStore],
  );

  const handleResetAllData = useCallback(async () => {
    if (activeClipJobs.length) {
      notify("Clip finding in progress", "Wait for clip finding to finish before resetting local data", "error");
      return;
    }
    if (activeRenders.length) {
      notify("Render in progress", "Cancel active renders before resetting local data", "error");
      return;
    }
    try {
      await clearApiKeys();
      resetAllLocalData();
      window.location.reload();
    } catch (error) {
      notify("Reset failed", String(error), "error");
    }
  }, [activeRenders.length, activeClipJobs.length]);

  const saveChannelProfiles = (
    profiles: ChannelProfile[],
    defaultId: string | null,
  ) => {
    setChannelProfiles(profiles);
    setDefaultChannelIdState(defaultId);
    saveProfiles(profiles);
    setDefaultProfileId(defaultId);
  };

  // Initial scan on mount — quiet: the result is already visible in
  // the top bar and Settings, so no popup on every launch.
  useEffect(() => {
    fetchClis(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pro desktop keyboard navigation (1-4 keys)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "1") setActiveTab("studio");
      else if (e.key === "2") setActiveTab("social");
      else if (e.key === "3") setActiveTab("scheduler");
      else if (e.key === "4") setActiveTab("settings");
      else if (e.key === "5") setActiveTab("performance");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const fetchClis = async (quiet = false) => {
    setIsLoadingClis(true);
    setGlobalTask({ type: "scanning", label: "Scanning system CLIs & agents" });
    try {
      const scanned = await ipc.scanClis();
      setTools(scanned);
      if (!quiet) {
        const available = scanned.filter((t) => t.is_available).length;
        triggerToast(
          "CLI scan complete",
          `${available} of ${scanned.length} tools detected in PATH`,
          "info",
        );
      }
    } catch (err: unknown) {
      console.error("Failed to scan CLIs:", err);
      triggerToast("Scan error", "Failed to query system CLIs", "error");
    } finally {
      setIsLoadingClis(false);
      setGlobalTask({ type: "idle" });
    }
  };

  const handleToggleTool = (id: string) => {
    setTools((prev) =>
      prev.map((t) => (t.id === id ? { ...t, is_enabled: !t.is_enabled } : t)),
    );
  };

  const handleRemoveTool = (id: string) => {
    setTools((prev) => prev.filter((t) => t.id !== id));
    triggerToast("Tool removed", "Binary removed from registry", "info");
  };

  const handleAddCustomTool = async (name: string, pathOrCmd: string) => {
    setGlobalTask({ type: "probing", label: `Probing ${name}` });
    try {
      const probed = await ipc.probeCustomCli(name, pathOrCmd);
      setTools((prev) => [...prev, probed]);
      if (probed.is_available) {
        triggerToast(
          "Custom binary registered",
          `${name} is ready (${probed.version || "active"})`,
          "success",
        );
      } else {
        triggerToast(
          "Binary unreachable",
          `${name} was not found at specified path`,
          "error",
        );
      }
    } catch (err: unknown) {
      triggerToast(
        "Probe failed",
        err instanceof Error ? err.message : "Could not register binary",
        "error",
      );
    } finally {
      setGlobalTask({ type: "idle" });
    }
  };

  const handleRunCommand = async (
    command: string,
    args: string[],
  ): Promise<CommandOutput> => {
    return await ipc.runCli(command, args);
  };

  const handleProbeVideo = async (
    path: string,
    options?: { silent?: boolean },
  ): Promise<VideoMetadata> => {
    if (!options?.silent) {
      setGlobalTask({ type: "probing", label: "Probing video stream" });
    }
    try {
      const meta = await ipc.probeVideo(path);
      if (!options?.silent) {
        triggerToast(
          "Footage probed",
          `${meta.width}x${meta.height} @ ${meta.fps}fps (${meta.duration_seconds}s)`,
          "success",
        );
      }
      return meta;
    } finally {
      if (!options?.silent) setGlobalTask({ type: "idle" });
    }
  };

  const handleJobUpdate = (update: RenderJobUpdate) => {
    if (update.running) {
      setGlobalTask({
        type: "rendering",
        label: update.label || "Rendering short",
        progress: update.progress,
      });
    } else {
      setGlobalTask({ type: "idle" });
      if (update.success && update.outputPath) {
        setPublishedVideoPath(update.outputPath);
      }
    }
  };

  const handleGetZernioAccounts = async (
    apiKey: string,
  ): Promise<ZernioAccount[]> => {
    return await ipc.getZernioAccounts(apiKey);
  };

  const handleConnectPlatform = async (
    apiKey: string,
    platform: string,
  ): Promise<void> => {
    setGlobalTask({
      type: "publishing",
      label: `Connecting ${platform.toUpperCase()}...`,
    });
    try {
      const connectUrl = await ipc.getZernioConnectUrl(apiKey, platform);
      if (connectUrl) {
        await ipc.openExternalUrl(connectUrl);
        triggerToast(
          "OAuth handshake launched",
          `Follow browser prompt to authorize ${platform.toUpperCase()}`,
          "info",
        );
      } else {
        triggerToast(
          "Connection error",
          `Could not generate OAuth redirect for ${platform}`,
          "error",
        );
      }
    } catch (err: unknown) {
      triggerToast(
        "OAuth error",
        err instanceof Error ? err.message : "Failed to open connect URL",
        "error",
      );
      throw err;
    } finally {
      setGlobalTask({ type: "idle" });
    }
  };

  // One-shot SEO analysis for the Queue quick-schedule card: same
  // engine call the Studio uses (selected CLI when one is saved, else
  // composed Auto-cut titles). Rejects on failure so the card shows the
  // error instead of template text.
  const handleAnalyzeForQueue = async (
    videoPath: string,
  ): Promise<{ title: string; description: string; tags: string[] }> => {
    const meta = await ipc.generateSeoMetadata(
      videoPath,
      getEffectiveContext(""),
      preferredSeoAgent(studioStore),
      elevenLabsKey.trim() ? elevenLabsKey.trim() : undefined,
      transcriptionProvider,
    );
    return {
      title: meta.title,
      description: meta.description,
      tags: [...(meta.tags ?? [])],
    };
  };

  // App-owned Studio SEO jobs. The fetch outlives the Studio view:
  // switching tabs unmounts VideoStudio mid-analysis, so the result lands
  // here (App never unmounts) and is merged into the matching draft.
  // requestId keeps stale finishes from overwriting newer work.
  const [seoJobs, setSeoJobs] = useState<StudioSeoJobs>({});
  const seoRequestRef = useRef(0);
  const latestSeoRequests = useRef(new Map<string, number>());

  const handleGenerateStudioSeo = async (
    targetVideo: string,
    opts: { context: string; agentId?: string },
  ): Promise<{ meta: SeoMetadata; requestId: number }> => {
    const requestId = ++seoRequestRef.current;
    latestSeoRequests.current.set(targetVideo, requestId);
    const startedAt = new Date().toISOString();
    setSeoJobs((prev) => startSeoJob(prev, targetVideo, requestId, startedAt));
    setGlobalTask((prev) =>
      prev.type === "idle"
        ? { type: "analyzing", label: "Analyzing video SEO" }
        : prev,
    );
    try {
      const meta = await ipc.generateSeoMetadata(
        targetVideo,
        opts.context,
        opts.agentId,
        elevenLabsKey?.trim() ? elevenLabsKey.trim() : undefined,
        transcriptionProvider,
      );
      if (latestSeoRequests.current.get(targetVideo) !== requestId) return { meta, requestId };
      setSeoJobs((prev) =>
        finishSeoJob(prev, targetVideo, requestId, meta, new Date().toISOString()),
      );
      setStudioStore((prev) => applyStudioSeo(prev, targetVideo, meta));
      notify("Analysis complete", `SEO package ready for ${targetVideo.split(/[\\/]/).pop() || targetVideo}`, "success");
      return { meta, requestId };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Could not analyze video";
      if (latestSeoRequests.current.get(targetVideo) !== requestId) throw err;
      setSeoJobs((prev) =>
        failSeoJob(prev, targetVideo, requestId, message, new Date().toISOString()),
      );
      notify("Review failed", message, "error");
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setGlobalTask((prev) =>
        prev.type === "analyzing" ? { type: "idle" } : prev,
      );
    }
  };

  // Local-first scheduling: the short joins the queue immediately (no
  // gateway call), so it is always visible and postable from Queue.
  // One video_path queues once: a repeat (Social or the QuickSchedule
  // card) returns the existing entry instead of adding a duplicate row.
  const handleQueueShort = (payload: SocialPublishPayload): ScheduleItem => {
    const existing = findQueueItemByVideoPath(queue, payload.video_path);
    if (existing) {
      triggerToast(
        "Already queued",
        "This short is already in the Queue",
        "info",
      );
      return existing;
    }
    const entry = newScheduleItem({ ...payload, publish_now: false });
    setQueue((prev) => [entry, ...prev]);
    triggerToast(
      "Short queued",
      `Releases ${formatScheduledLabel(entry.scheduled_for)} — it posts while 2pixelshorts is open`,
      "success",
    );
    return entry;
  };

  const handlePublishToZernio = async (
    apiKey: string,
    payload: SocialPublishPayload,
  ): Promise<string> => {
    // Entry-first: the attempt is recorded before dispatching, so even a
    // failed gateway call leaves a retryable row in the queue.
    const entry = newScheduleItem(payload);
    setQueue((prev) =>
      markDispatching([entry, ...prev], entry.id),
    );
    setGlobalTask({ type: "publishing", label: "Dispatching to Zernio API" });
    try {
      const result = await ipc.publishToZernio(apiKey, {
        ...payload,
        idempotency_key: entry.id,
      });
      const postId = extractPostId(result) ?? undefined;
      const remoteStatus = postStatusOf(result)?.toLowerCase() ?? null;
      const failureDetail = platformFailureMessage(result);
      if (remoteStatus === "failed") {
        const msg =
          failureDetail ?? "Gateway reported failure — kept in Queue for retry";
        setQueue((prev) =>
          markDispatchFailed(prev, entry.id, msg, postId).map((q) =>
            q.id === entry.id ? { ...q, remote_status: remoteStatus } : q,
          ),
        );
        throw new Error(msg);
      }
      setQueue((prev) =>
        markDispatched(prev, entry.id, postId).map((q) =>
          q.id === entry.id
            ? {
                ...q,
                remote_status: remoteStatus ?? q.remote_status,
                error: remoteStatus === "partial" ? failureDetail : null,
              }
            : q,
        ),
      );
      if (remoteStatus === "partial") {
        triggerToast(
          "Partly published",
          failureDetail ?? "Some channels failed — the post is in Queue",
          "error",
        );
      } else if (remoteStatus && remoteStatus !== "published") {
        triggerToast(
          "Post saved",
          `Gateway status: ${remoteStatus} — sync from Queue for updates`,
          "info",
        );
      } else {
        triggerToast(
          "Post dispatched",
          `Sent to ${payload.platforms.join(", ")}`,
          "success",
        );
      }
      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Zernio API request error";
      setQueue((prev) => markDispatchFailed(prev, entry.id, message));
      triggerToast("Publishing failed", `${message} — kept in Queue for retry`, "error");
      throw err;
    } finally {
      setGlobalTask({ type: "idle" });
    }
  };

  // Queue a finished render output for posting (no re-render needed).
  // Carries the meta-page SEO: the live values when given, else the SEO
  // captured on the history entry when the render started.
  const handleQueueOutput = useCallback(
    (outputPath: string, seo?: OutputSeo) => {
      if (queue.some((q) => q.video_path === outputPath)) {
        triggerToast("Already queued", "This short is already in the Queue", "info");
        return;
      }
      const stored = renderHistory.find((h) => h.outputVideo === outputPath)?.seo;
      handleQueueShort(
        queuePayloadForOutput(outputPath, {
          title: seo?.title?.trim() || stored?.title,
          description: seo?.description ?? stored?.description ?? "",
          tags: seo?.tags ?? stored?.tags ?? [],
        }),
      );
    },
    [queue, renderHistory],
  );

  const readyOutputs = useMemo(
    () => unqueuedOutputs(renderHistory, queue.map((q) => q.video_path)),
    [renderHistory, queue],
  );

  const shortsForSocial = useMemo(
    () => selectableShorts(queue, renderHistory),
    [queue, renderHistory],
  );

  const handleSelectShortForSocial = (short: SelectableShort) => {
    setPublishedVideoPath(short.videoPath);
    setPublishedMetadata({
      title: short.title,
      description: short.description,
      tags: short.tags,
    });
    setPublishedSchedule({});
  };

  const handleClearSocialShort = () => {
    setPublishedVideoPath("");
    setPublishedMetadata({});
    setPublishedSchedule({});
  };

  // Post a queued short now (Queue page action, and the open-app timer).
  const handleDispatchJob = async (id: string) => {
    const item = queueRef.current.find((q) => q.id === id);
    if (!item) return;
    const blocked = canPostItem(item, zernioKey);
    if (blocked) {
      triggerToast("Cannot post yet", blocked, "error");
      return;
    }
    setQueue((prev) => markDispatching(prev, id));
    setGlobalTask({ type: "publishing", label: "Dispatching to Zernio API" });
    try {
      const result = await ipc.publishToZernio(
        zernioKey,
        toPublishPayload(item),
      );
      const postId = extractPostId(result) ?? undefined;
      const remoteStatus = postStatusOf(result)?.toLowerCase() ?? null;
      const failureDetail = platformFailureMessage(result);
      if (remoteStatus === "failed") {
        const msg =
          failureDetail ?? "Gateway reported failure — kept in Queue for retry";
        setQueue((prev) =>
          markDispatchFailed(prev, id, msg, postId).map((q) =>
            q.id === id ? { ...q, remote_status: remoteStatus } : q,
          ),
        );
        triggerToast("Dispatch failed", msg, "error");
      } else {
        setQueue((prev) =>
          markDispatched(prev, id, postId).map((q) =>
            q.id === id
              ? {
                  ...q,
                  remote_status: remoteStatus ?? q.remote_status,
                  error: remoteStatus === "partial" ? failureDetail : null,
                }
              : q,
          ),
        );
        if (remoteStatus === "partial") {
          triggerToast(
            "Partly published",
            failureDetail ?? "Some channels failed — sync for updates",
            "error",
          );
        } else if (remoteStatus && remoteStatus !== "published") {
          triggerToast(
            "Post saved",
            `Gateway status: ${remoteStatus} — sync for updates`,
            "info",
          );
        } else {
          triggerToast(
            "Post dispatched",
            `Sent to ${item.platforms.join(", ")}`,
            "success",
          );
        }
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Zernio API request error";
      setQueue((prev) => markDispatchFailed(prev, id, message));
      triggerToast("Dispatch failed", `${message} — kept in Queue for retry`, "error");
    } finally {
      setGlobalTask({ type: "idle" });
    }
  };

  // While this window is open, send posts whose release time has passed.
  // Closing the app pauses the queue; nothing is sent in the background.
  const dispatchRef = useRef(handleDispatchJob);
  dispatchRef.current = handleDispatchJob;
  useEffect(() => {
    let stopped = false;
    const inFlight = new Set<string>();
    const tick = async () => {
      const ids = dueDispatchIds(queueRef.current, zernioKeyRef.current);
      for (const id of ids) {
        if (stopped || inFlight.has(id)) continue;
        inFlight.add(id);
        try {
          await dispatchRef.current(id);
        } finally {
          inFlight.delete(id);
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 30_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  // In-place queue edit (title, SEO, channels, release slot) from the
  // Queue page. Optional patch fields never clobber: an omitted
  // schedule/platforms/timezone keeps the entry's current values.
  const handleUpdateJob = (id: string, patch: QueueItemPatch) => {
    setQueue((prev) =>
      prev.map((q) =>
        q.id === id
          ? {
              ...q,
              title: patch.title,
              description: patch.description,
              tags: [...patch.tags],
              scheduled_for: patch.scheduled_for,
              timezone: patch.timezone,
              ...(patch.platforms !== undefined
                ? { platforms: [...patch.platforms] }
                : {}),
              ...(patch.account_ids !== undefined
                ? { account_ids: [...patch.account_ids] }
                : {}),
            }
          : q,
      ),
    );
    triggerToast("Queue updated", "Release details saved", "success");
  };

  // Re-analyze a queued video for its best title, description & tags.
  const handleReanalyzeJob = async (
    id: string,
  ): Promise<QueueSeoPatch | null> => {
    const item = queue.find((q) => q.id === id);
    if (!item) return null;
    setGlobalTask({ type: "publishing", label: "Re-analyzing video SEO" });
    try {
      const meta = await ipc.generateSeoMetadata(
        item.video_path,
        getEffectiveContext("") || undefined,
        preferredSeoAgent(studioStore),
        elevenLabsKey?.trim() ? elevenLabsKey.trim() : undefined,
        transcriptionProvider,
      );
      const patch = buildSeoPatch(meta);
      setQueue((prev) =>
        prev.map((q) => (q.id === id ? { ...q, ...patch } : q)),
      );
      triggerToast(
        "SEO refreshed",
        `New title: ${patch.title.slice(0, 80)}`,
        "success",
      );
      return patch;
    } catch (err: unknown) {
      triggerToast(
        "Re-analysis failed",
        err instanceof Error ? err.message : "Could not analyze video",
        "error",
      );
      return null;
    } finally {
      // Only clear our own indicator — a render that started meanwhile
      // keeps its global task.
      setGlobalTask((prev) =>
        prev.type === "publishing" ? { type: "idle" } : prev,
      );
    }
  };

  // Load a queued short into Social with its existing metadata, release
  // slot, and channels — nothing is dropped: Social starts from the queued
  // schedule/platforms/timezone (account ids stay on the queue entry and
  // are re-derived from live accounts at publish time).
  const handleEditInSocial = (id: string) => {
    const item = queue.find((q) => q.id === id);
    if (!item) return;
    setPublishedVideoPath(item.video_path);
    setPublishedMetadata({
      title: item.title,
      description: item.description,
      tags: item.tags,
    });
    setPublishedSchedule({
      scheduled_for: item.scheduled_for,
      timezone: item.timezone,
      platforms: [...item.platforms],
    });
    setActiveTab("social");
  };

  const handleDeleteJob = (id: string) => {
    setQueue((prev) => removeQueueItem(prev, id));
    triggerToast("Post deleted", "Post removed from queue", "info");
  };

  // Queue hygiene: drop every completed row, keep the rest in place.
  const handleClearCompleted = useCallback(() => {
    const completed = queue.filter((q) => q.status === "completed").length;
    if (completed === 0) {
      triggerToast("Nothing to clear", "No completed posts in the queue", "info");
      return;
    }
    setQueue((prev) => clearCompletedItems(prev));
    triggerToast(
      "Queue cleaned",
      `${completed} completed post${completed === 1 ? "" : "s"} cleared`,
      "info",
    );
  }, [queue]);

  const handleCancelJob = handleDeleteJob;

  const handleSyncJob = async (id: string) => {
    const item = queue.find((q) => q.id === id);
    if (!item?.post_id) {
      triggerToast("Sync unavailable", "No gateway post id recorded", "error");
      return;
    }
    setGlobalTask({ type: "publishing", label: "Syncing post status" });
    try {
      const text = await ipc.getPostStatus(zernioKey, item.post_id);
      const raw = postStatusOf(text);
      if (!raw) {
        triggerToast("Sync unclear", "Gateway gave no readable status", "error");
        return;
      }
      const mapped = mapRemoteStatus(raw);
      setQueue((prev) =>
        prev.map((q) =>
          q.id === id
            ? {
                ...q,
                remote_status: raw,
                status: mapped ?? q.status,
              }
            : q,
        ),
      );
      triggerToast(
        "Status synced",
        mapped ? `Post is ${mapped}` : `Gateway reports: ${raw}`,
        "success",
      );
    } catch (err: unknown) {
      triggerToast(
        "Sync failed",
        err instanceof Error ? err.message : "Status request error",
        "error",
      );
    } finally {
      setGlobalTask({ type: "idle" });
    }
  };

  const handleRetryJob = async (id: string) => {
    // Retry every failed row, even one without a gateway post id: delegate
    // to the Post-now dispatch, which rebuilds the payload from the stored
    // entry with a fresh idempotency key. Replaying a stored gateway post
    // would fail again with the same body, so the entry is re-sent instead.
    await handleDispatchJob(id);
  };

  const handlePickVideo = async (): Promise<string | null> => {
    return await ipc.pickVideoFile();
  };

  const handleOpenFileLocation = async (path: string): Promise<void> => {
    try {
      await ipc.openFileLocation(path);
    } catch (err: unknown) {
      triggerToast(
        "Explorer error",
        err instanceof Error ? err.message : "Failed to open directory",
        "error",
      );
    }
  };

  const handleOpenFile = async (path: string): Promise<void> => {
    try {
      await ipc.openFile(path);
    } catch (err: unknown) {
      triggerToast(
        "Player error",
        err instanceof Error ? err.message : "Failed to open media player",
        "error",
      );
    }
  };

  const navigateToClis = () => {
    setActiveTab("settings");
    setSettingsSubTab("clis");
  };

  const availableCliCount = tools.filter(
    (t) => t.is_available && t.is_enabled,
  ).length;
  const totalCliCount = tools.length;
  const displayedTask: GlobalTaskStatus =
    globalTask.type === "idle" && runningClipJobs.length
      ? { type: "analyzing", label: "Finding clips" }
      : globalTask.type === "idle" && watchingClipJobs.length
        ? { type: "analyzing", label: "Waiting for live VOD" }
        : globalTask;

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-full bg-background font-sans text-foreground">
      <Sidebar
        activeTab={activeTab}
        onNavigate={setActiveTab}
        queueCount={queue.length}
        colorMode={colorMode}
        onColorModeChange={(mode) => setTheme(mode)}
        sources={sidebarEntries}
        selectedSourceId={studioStore.currentId}
        onSelectSource={handleSelectSource}
        onNewSource={handleNewSource}
        onRemoveSource={handleRemoveSource}
        onRemoveSources={handleRemoveSources}
        streams={streamItems}
        selectedStreamUrl={selectedStreamUrl}
        onSelectStream={handleSelectStream}
        onRemoveStream={handleRemoveStream}
        clipJobs={clipActivity}
        onDismissClipJob={dismissStreamJob}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        {displayedTask.type !== "idle" && (
          <div className="absolute inset-x-0 top-0 z-10">
            <LinearProgress
              progress={
                displayedTask.type === "rendering" &&
                typeof displayedTask.progress === "number"
                  ? Math.round(displayedTask.progress * 100)
                  : undefined
              }
            />
          </div>
        )}

        <main className="app-main min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          <div className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-6 lg:px-6 xl:px-8">
            <div key={activeTab}>
                {activeTab === "studio" && (
                  <VideoStudio
                    key={studioBlankKey}
                    elevenLabsKey={elevenLabsKey}
                    youtubeKey={youtubeKey}
                    onJobUpdate={handleJobUpdate}
                    onGenerateStudioSeo={handleGenerateStudioSeo}
                    studioSeoJobs={seoJobs}
                    onRenderStarted={handleRenderStarted}
                    renderHistory={renderHistory}
                    activeHistoryJobId={latestRender?.id ?? null}
                    onOpenJobs={() => setIsJobsOpen(true)}
                    onCancelRenderJob={handleCancelRenderJob}
                    onDismissRenderJob={handleDismissRenderJob}
                    onClearFinishedRenders={handleClearFinishedRenders}
                    initialDraft={currentDraft}
                    draftLoadKey={draftLoadKey}
                    onDraftChange={handleDraftChange}
                    onImportClipsAsSources={handleImportClipsAsSources}
                    streamRuns={streamRuns}
                    onStreamRunsChange={setStreamRuns}
                    streamAnalysisJobs={streamAnalysisJobs}
                    onAnalyzeStream={(url, options, layout) => {
                      setStartBlankStudio(false);
                      setSelectedStreamUrl(url);
                      void startAnalysis(url, options, layout);
                    }}
                    onStopWatchingStream={stopWatchingStream}
                    onRemoveStream={handleRemoveStream}
                    pendingStreamUrl={pendingStream?.url ?? null}
                    streamOpenKey={pendingStream?.key ?? 0}
                    onStreamOpened={() => setPendingStream(null)}
                    startBlank={startBlankStudio}
                    onQueueOutput={handleQueueOutput}
                    onProbeVideo={handleProbeVideo}
                    onPickVideo={handlePickVideo}
                    onOpenFileLocation={handleOpenFileLocation}
                    onOpenFile={handleOpenFile}
                    onSendToSocial={(videoPath, metadata) => {
                      setPublishedVideoPath(videoPath);
                      setPublishedMetadata(metadata ?? {});
                      setPublishedSchedule({});
                      setActiveTab("social");
                    }}
                  />
                )}

                {activeTab === "social" && (
                  <SocialPublisher
                    apiKey={zernioKey}
                    onSaveApiKey={saveZernioKey}
                    onPublish={handlePublishToZernio}
                    onQueueShort={handleQueueShort}
                    onGetAccounts={handleGetZernioAccounts}
                    onConnectPlatform={handleConnectPlatform}
                    initialVideoPath={publishedVideoPath}
                    initialTitle={publishedMetadata.title}
                    initialDescription={publishedMetadata.description}
                    initialTags={publishedMetadata.tags}
                    initialPlatforms={publishedSchedule.platforms}
                    initialScheduledFor={publishedSchedule.scheduled_for}
                    initialTimezone={publishedSchedule.timezone}
                    availableShorts={shortsForSocial}
                    onSelectShort={handleSelectShortForSocial}
                    onDismissShortOutput={handleDismissOutput}
                    onDeleteQueuedShort={handleDeleteJob}
                    onClearShort={handleClearSocialShort}
                    onOpenStudio={() => setActiveTab("studio")}
                    onOpenQueue={() => setActiveTab("scheduler")}
                  />
                )}

                {activeTab === "scheduler" && (
                  <ScheduleQueue
                    queue={queue}
                    onDeleteJob={handleDeleteJob}
                    onCancelJob={handleCancelJob}
                    onClearCompleted={handleClearCompleted}
                    onSyncJob={handleSyncJob}
                    onRetryJob={handleRetryJob}
                    onDispatchJob={handleDispatchJob}
                    onEditJob={handleEditInSocial}
                    readyOutputs={readyOutputs}
                    onQueueOutput={handleQueueOutput}
                    onDismissOutput={handleDismissOutput}
                    onNewShort={handleNewSource}
                    onUpdateJob={handleUpdateJob}
                    onReanalyzeJob={handleReanalyzeJob}
                    onOpenFile={handleOpenFile}
                    onOpenFileLocation={handleOpenFileLocation}
                    onPickVideo={handlePickVideo}
                    onAnalyzeVideo={handleAnalyzeForQueue}
                    onQueueShort={handleQueueShort}
                    transcription={transcription}
                    apiKey={zernioKey}
                    onGetAccounts={handleGetZernioAccounts}
                    onNavigateToStudio={() => setActiveTab("studio")}
                  />
                )}

                {activeTab === "performance" && (
                  <PerformanceView
                    records={postPerformance.records}
                    refreshing={postPerformance.refreshing}
                    onRefresh={() => void postPerformance.refresh(true)}
                    hasZernioKey={!!zernioKey.trim()}
                    onOpenSettings={() => {
                      setActiveTab("settings");
                      setSettingsSubTab("keys");
                    }}
                    onOpenQueue={() => setActiveTab("scheduler")}
                  />
                )}

                {activeTab === "settings" && (
                  <SettingsView
                    transcriptionProvider={transcriptionProvider}
                    onTranscriptionProviderChange={handleTranscriptionProviderChange}
                    zernioKey={zernioKey}
                    onSaveZernioKey={saveZernioKey}
                    elevenLabsKey={elevenLabsKey}
                    onSaveElevenLabsKey={saveElevenLabsKey}
                    youtubeKey={youtubeKey}
                    onSaveYoutubeKey={saveYoutubeKey}
                    onTriggerToast={triggerToast}
                    tools={tools}
                    isLoadingClis={isLoadingClis}
                    onRefreshClis={() => fetchClis(false)}
                    onToggleTool={handleToggleTool}
                    onRemoveTool={handleRemoveTool}
                    onAddCustomTool={handleAddCustomTool}
                    onRunCommand={handleRunCommand}
                    activeSubTab={settingsSubTab}
                    onSubTabChange={setSettingsSubTab}
                    colorMode={colorMode}
                    onColorModeChange={(mode) => setTheme(mode)}
                    channelProfiles={channelProfiles}
                    defaultChannelId={defaultChannelId}
                    onSaveChannelProfiles={saveChannelProfiles}
                    onResetAllData={handleResetAllData}
                    storageScope={storageScope}
                    onStorageCleaned={handleStorageCleaned}
                  />
                )}
            </div>
          </div>
        </main>

        <StatusBar
          desktop={ipc.isTauri()}
          globalTask={displayedTask}
          cliAvailable={availableCliCount}
          cliTotal={totalCliCount}
          queueCount={queue.length}
          activeRenderCount={activeRenders.length}
          renderProgress={latestRender?.progress}
          onOpenJobs={() => setIsJobsOpen(true)}
          onOpenClis={navigateToClis}
          activeClipCount={activeClipJobs.length}
          onOpenClips={() => {
            const job = runningClipJobs[0] ?? watchingClipJobs[0];
            if (job) handleSelectStream(job.url);
          }}
        />
        <RenderJobsDrawer
          isOpen={isJobsOpen}
          onClose={() => setIsJobsOpen(false)}
          jobs={renderHistory}
          onCancel={handleCancelRenderJob}
          onDismiss={handleDismissRenderJob}
          onClearFinished={handleClearFinishedRenders}
          onOpenFileLocation={handleOpenFileLocation}
          onOpenFile={handleOpenFile}
          onQueueOutput={handleQueueOutput}
        />
      </div>

        <AppToasts />
      </div>
    </MotionConfig>
  );
}

export default App;
