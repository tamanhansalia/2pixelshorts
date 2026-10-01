import { useState, useEffect } from "react";
import * as ipc from "./lib/ipc";
import { motion, AnimatePresence } from "framer-motion";
import { Navbar, NavTab } from "./components/layout/Navbar";
import { VideoStudio } from "./components/studio/VideoStudio";
import { SocialPublisher } from "./components/social/SocialPublisher";
import { ScheduleQueue } from "./components/scheduler/ScheduleQueue";
import { SettingsView, SettingsSubTab } from "./components/settings/SettingsView";
import { ToastContainer, ToastMessage } from "./components/ui/Toast";
import { 
  CliToolInfo, 
  CommandOutput, 
  VideoMetadata, 
  SocialPublishPayload, 
  ScheduleItem,
  GlobalTaskStatus,
  RenderShortParams,
  ZernioAccount,
  HeroUiThemeId,
  HERO_UI_THEMES
} from "./types";

export function App() {
  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const hash = window.location.hash.replace("#", "");
    if (hash.startsWith("settings")) {
      return "settings";
    }
    if (["studio", "social", "scheduler"].includes(hash)) {
      return hash as NavTab;
    }
    return "studio";
  });
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsSubTab>(() => {
    const hash = window.location.hash.replace("#", "");
    if (hash === "settings-themes") return "themes";
    if (hash === "settings-keys") return "keys";
    if (hash === "settings-engine") return "engine";
    return "clis";
  });
  const [theme, setTheme] = useState<HeroUiThemeId>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlTheme = urlParams.get("theme") as HeroUiThemeId | null;
    if (urlTheme && HERO_UI_THEMES.some((t) => t.id === urlTheme)) return urlTheme;
    return (localStorage.getItem("2pixel_heroui_theme") as HeroUiThemeId) || "default";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("2pixel_heroui_theme", theme);
  }, [theme]);

  useEffect(() => {
    window.location.hash = activeTab;
  }, [activeTab]);
  const [tools, setTools] = useState<CliToolInfo[]>(ipc.MOCK_TOOLS);
  const [isLoadingClis, setIsLoadingClis] = useState(false);
  const [globalTask, setGlobalTask] = useState<GlobalTaskStatus>({ type: "idle" });
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // API Keys stored in localStorage
  const [zernioKey, setZernioKey] = useState<string>(() => {
    return localStorage.getItem("2pixel_zernio_key") || "";
  });
  const [elevenLabsKey, setElevenLabsKey] = useState<string>(() => {
    return localStorage.getItem("2pixel_elevenlabs_key") || "";
  });
  const [publishedVideoPath, setPublishedVideoPath] = useState<string>("final_short.mp4");
  const [publishedMetadata, setPublishedMetadata] = useState<{ title?: string; description?: string; tags?: string[] }>({});

  // Scheduled Posts Queue
  const [queue, setQueue] = useState<ScheduleItem[]>(() => {
    const saved = localStorage.getItem("2pixel_schedule_queue");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return [];
      }
    }
    return [];
  });

  // Save queue on change
  useEffect(() => {
    localStorage.setItem("2pixel_schedule_queue", JSON.stringify(queue));
  }, [queue]);

  const triggerToast = (
    title: string, 
    description?: string, 
    type: "success" | "error" | "info" = "info"
  ) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    setToasts((prev) => [...prev, { id, title, description, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const saveZernioKey = (key: string) => {
    setZernioKey(key);
    localStorage.setItem("2pixel_zernio_key", key);
  };

  const saveElevenLabsKey = (key: string) => {
    setElevenLabsKey(key);
    localStorage.setItem("2pixel_elevenlabs_key", key);
  };

  // Initial scan on mount
  useEffect(() => {
    fetchClis();
  }, []);

  // Pro desktop keyboard navigation (1-5 keys)
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
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const fetchClis = async () => {
    setIsLoadingClis(true);
    setGlobalTask({ type: "scanning", label: "Scanning system CLIs & agents" });
    try {
      const scanned = await ipc.scanClis();
      setTools(scanned);
      const available = scanned.filter((t) => t.is_available).length;
      triggerToast("CLI Scan Complete", `${available} of ${scanned.length} tools detected in PATH`, "info");
    } catch (err: any) {
      console.error("Failed to scan CLIs:", err);
      triggerToast("Scan Error", "Failed to query system CLIs", "error");
    } finally {
      setIsLoadingClis(false);
      setGlobalTask({ type: "idle" });
    }
  };

  const handleToggleTool = (id: string) => {
    setTools((prev) =>
      prev.map((t) => (t.id === id ? { ...t, is_enabled: !t.is_enabled } : t))
    );
  };

  const handleRemoveTool = (id: string) => {
    setTools((prev) => prev.filter((t) => t.id !== id));
    triggerToast("Tool Removed", "Binary removed from registry", "info");
  };

  const handleAddCustomTool = async (name: string, pathOrCmd: string) => {
    setGlobalTask({ type: "probing", label: `Probing ${name}` });
    try {
      const probed = await ipc.probeCustomCli(name, pathOrCmd);
      setTools((prev) => [...prev, probed]);
      if (probed.is_available) {
        triggerToast("Custom Binary Registered", `${name} is ready (${probed.version || "active"})`, "success");
      } else {
        triggerToast("Binary Unreachable", `${name} was not found at specified path`, "error");
      }
    } catch (err: any) {
      triggerToast("Probe Failed", err?.toString() || "Could not register binary", "error");
    } finally {
      setGlobalTask({ type: "idle" });
    }
  };

  const handleRunCommand = async (command: string, args: string[]): Promise<CommandOutput> => {
    return await ipc.runCli(command, args);
  };

  const handleProbeVideo = async (path: string): Promise<VideoMetadata> => {
    setGlobalTask({ type: "probing", label: "Probing video stream" });
    try {
      const meta = await ipc.probeVideo(path);
      triggerToast("Footage Probed", `${meta.width}x${meta.height} @ ${meta.fps}fps (${meta.duration_seconds}s)`, "success");
      return meta;
    } catch (err: any) {
      triggerToast("Probe Error", err?.toString() || "ffprobe failed to analyze file", "error");
      throw err;
    } finally {
      setGlobalTask({ type: "idle" });
    }
  };

  const handleRenderShort = async (
    params: RenderShortParams
  ): Promise<CommandOutput> => {
    setGlobalTask({ type: "rendering", label: `Rendering short with ${params.agent_id || "pipeline"}` });
    try {
      const result = await ipc.renderShort({
        ...params,
        elevenlabs_key: elevenLabsKey || params.elevenlabs_key,
      });
      if (result.success) {
        setPublishedVideoPath(params.output_video);
        triggerToast("Short Rendered", `Output saved to ${params.output_video}`, "success");
      } else {
        triggerToast("Render Error", "Short pipeline failed with non-zero exit code", "error");
      }
      return result;
    } catch (err: any) {
      triggerToast("Render Failed", err?.toString() || "Render process encountered error", "error");
      throw err;
    } finally {
      setGlobalTask({ type: "idle" });
    }
  };

  const handleGetZernioAccounts = async (apiKey: string): Promise<ZernioAccount[]> => {
    return await ipc.getZernioAccounts(apiKey);
  };

  const handleConnectPlatform = async (apiKey: string, platform: string): Promise<void> => {
    setGlobalTask({ type: "publishing", label: `Connecting ${platform.toUpperCase()}...` });
    try {
      const connectUrl = await ipc.getZernioConnectUrl(apiKey, platform);
      if (connectUrl) {
        await ipc.openExternalUrl(connectUrl);
        triggerToast("OAuth Handshake Launched", `Follow browser prompt to authorize ${platform.toUpperCase()}`, "info");
      } else {
        triggerToast("Connection Error", `Could not generate OAuth redirect for ${platform}`, "error");
      }
    } catch (err: any) {
      triggerToast("OAuth Error", err?.toString() || "Failed to open connect URL", "error");
      throw err;
    } finally {
      setGlobalTask({ type: "idle" });
    }
  };

  const handlePublishToZernio = async (
    apiKey: string,
    payload: SocialPublishPayload
  ): Promise<string> => {
    setGlobalTask({ type: "publishing", label: "Dispatching to Zernio API" });
    try {
      const result = await ipc.publishToZernio(apiKey, payload);

      if (payload.publish_now) {
        triggerToast("Post Dispatched", `Sent to ${payload.platforms.join(", ")}`, "success");
      } else {
        triggerToast("Post Scheduled", `Queued for ${payload.scheduled_for}`, "success");
      }

      if (!payload.publish_now && payload.scheduled_for) {
        const newItem: ScheduleItem = {
          id: `job-${Date.now()}`,
          title: payload.title,
          video_path: payload.video_path,
          platforms: payload.platforms,
          scheduled_for: payload.scheduled_for,
          timezone: payload.timezone || "UTC",
          status: "queued",
          created_at: new Date().toISOString(),
        };
        setQueue((prev) => [newItem, ...prev]);
      }

      return result;
    } catch (err: any) {
      triggerToast("Publishing Failed", err?.toString() || "Zernio API request error", "error");
      throw err;
    } finally {
      setGlobalTask({ type: "idle" });
    }
  };

  const handleCancelJob = (id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
    triggerToast("Job Cancelled", "Post removed from queue", "info");
  };

  const handlePickVideo = async (): Promise<string | null> => {
    return await ipc.pickVideoFile();
  };

  const handleOpenFileLocation = async (path: string): Promise<void> => {
    try {
      await ipc.openFileLocation(path);
    } catch (err: any) {
      triggerToast("Explorer Error", err?.toString() || "Failed to open directory", "error");
    }
  };

  const handleOpenFile = async (path: string): Promise<void> => {
    try {
      await ipc.openFile(path);
    } catch (err: any) {
      triggerToast("Player Error", err?.toString() || "Failed to open media player", "error");
    }
  };

  const availableCliCount = tools.filter((t) => t.is_available && t.is_enabled).length;
  const totalCliCount = tools.length;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-accent selection:text-accent-foreground">
      {/* Top Navbar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        availableCliCount={availableCliCount}
        totalCliCount={totalCliCount}
        globalTask={globalTask}
        onNavigateToClis={() => {
          setActiveTab("settings");
          setSettingsSubTab("clis");
        }}
        currentTheme={theme}
        onSelectTheme={setTheme}
      />

      {/* Main Studio Viewport with Animated Transitions */}
      <main className="flex-1 p-6 max-w-7xl w-full mx-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            {activeTab === "studio" && (
              <VideoStudio
                onProbeVideo={handleProbeVideo}
                onRenderShort={handleRenderShort}
                onPickVideo={handlePickVideo}
                onOpenFileLocation={handleOpenFileLocation}
                onOpenFile={handleOpenFile}
                onSendToSocial={(videoPath, metadata) => {
                  setPublishedVideoPath(videoPath);
                  if (metadata) {
                    setPublishedMetadata(metadata);
                  }
                  setActiveTab("social");
                }}
              />
            )}

            {activeTab === "social" && (
              <SocialPublisher
                apiKey={zernioKey}
                onSaveApiKey={saveZernioKey}
                onPublish={handlePublishToZernio}
                onGetAccounts={handleGetZernioAccounts}
                onConnectPlatform={handleConnectPlatform}
                initialVideoPath={publishedVideoPath}
                initialTitle={publishedMetadata.title}
                initialDescription={publishedMetadata.description}
                initialTags={publishedMetadata.tags}
              />
            )}

            {activeTab === "scheduler" && (
              <ScheduleQueue
                queue={queue}
                onCancelJob={handleCancelJob}
                onNavigateToStudio={() => setActiveTab("studio")}
              />
            )}

            {activeTab === "settings" && (
              <SettingsView
                zernioKey={zernioKey}
                onSaveZernioKey={saveZernioKey}
                elevenLabsKey={elevenLabsKey}
                onSaveElevenLabsKey={saveElevenLabsKey}
                onTriggerToast={triggerToast}
                tools={tools}
                isLoadingClis={isLoadingClis}
                onRefreshClis={fetchClis}
                onToggleTool={handleToggleTool}
                onRemoveTool={handleRemoveTool}
                onAddCustomTool={handleAddCustomTool}
                onRunCommand={handleRunCommand}
                activeSubTab={settingsSubTab}
                onSubTabChange={setSettingsSubTab}
                currentTheme={theme}
                onSelectTheme={setTheme}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Floating Global HUD Toasts */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default App;
