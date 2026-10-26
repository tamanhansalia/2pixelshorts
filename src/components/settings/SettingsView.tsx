import { notify } from "../../lib/notify";
import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  Key,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Sun,
  Terminal,
  TvMinimalPlay,
} from "lucide-react";
import { InputGroup, Tabs } from "@heroui/react";
import { Button } from "../ui/Button";
import { PageHeader } from "../layout/PageHeader";
import { Badge } from "../ui/Badge";
import { SectionCard } from "../ui/Card";
import { Segmented } from "../ui/Segmented";
import type { TranscriptionProvider } from "../../lib/transcription";
import { CliToolInfo, CommandOutput, TranscriptionStatus } from "../../types";
import { openExternalUrl, probeTranscription, validateApiKey, isTauri } from "../../lib/ipc";
import { createLatestGuard, isUnsavedEdit } from "../../lib/asyncLatest";
import { CliManager } from "../cli/CliManager";
import { ChannelProfiles } from "./ChannelProfiles";
import { StorageSettings } from "./StorageSettings";
import type { StorageDeleteReport, StorageScope } from "../../lib/storage";
import type { ChannelProfile } from "../../lib/channelProfiles";
import type { ColorMode } from "../layout/Sidebar";

export type SettingsSubTab = "clis" | "keys" | "channel" | "appearance" | "engine" | "storage";

interface SettingsViewProps {
  transcriptionProvider: TranscriptionProvider;
  onTranscriptionProviderChange: (provider: TranscriptionProvider) => void;
  zernioKey: string;
  onSaveZernioKey: (key: string) => Promise<void>;
  elevenLabsKey: string;
  onSaveElevenLabsKey: (key: string) => Promise<void>;
  youtubeKey: string;
  onSaveYoutubeKey: (key: string) => Promise<void>;
  onTriggerToast?: (
    title: string,
    description?: string,
    type?: "success" | "error" | "info" | "warning",
  ) => void;
  // CLI & Agent Props
  tools?: CliToolInfo[];
  isLoadingClis?: boolean;
  onRefreshClis?: () => void;
  onToggleTool?: (id: string) => void;
  onRemoveTool?: (id: string) => void;
  onAddCustomTool?: (name: string, pathOrCmd: string) => Promise<void>;
  onRunCommand?: (command: string, args: string[]) => Promise<CommandOutput>;
  activeSubTab?: SettingsSubTab;
  onSubTabChange?: (tab: SettingsSubTab) => void;
  // Appearance
  colorMode: ColorMode;
  onColorModeChange: (mode: ColorMode) => void;
  // Channel context profiles
  channelProfiles: ChannelProfile[];
  defaultChannelId: string | null;
  onSaveChannelProfiles: (
    profiles: ChannelProfile[],
    defaultId: string | null,
  ) => void;
  // Complete local reset (clears storage, then reloads)
  onResetAllData?: () => void;
  // Storage cleanup: folders/in-use files from app records, and record updates after it
  storageScope?: StorageScope;
  onStorageCleaned?: (report: StorageDeleteReport) => void;
}

const EMPTY_STORAGE_SCOPE: StorageScope = { directories: ["."], recordPaths: [], renderedVideos: [], legacyStreamClips: [], protected: [] };

const SETTINGS_NAV: {
  id: SettingsSubTab;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "clis",
    label: "Tools & agents",
    description: "Installed tools. Switches control the console below; Studio verifies its processing tools separately.",
    icon: <Terminal />,
  },
  {
    id: "keys",
    label: "API keys",
    description: "Credentials for publishing, transcription and trends. Stored only on this machine.",
    icon: <Key />,
  },
  {
    id: "channel",
    label: "Channel",
    description: "Context that steers AI cuts, titles and tags.",
    icon: <TvMinimalPlay />,
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme for the studio.",
    icon: <Palette />,
  },
  {
    id: "engine",
    label: "Engine",
    description: "Transcription and local processing.",
    icon: <Cpu />,
  },
  {
    id: "storage",
    label: "Storage",
    description: "Space used by renders, downloads and leftovers. Clean up what you no longer need.",
    icon: <HardDrive />,
  },
];

const MODE_CARDS: { id: ColorMode; name: string; icon: React.ReactNode }[] = [
  { id: "light", name: "Light", icon: <Sun className="size-3.5" /> },
  { id: "dark", name: "Dark", icon: <Moon className="size-3.5" /> },
  { id: "system", name: "System", icon: <Monitor className="size-3.5" /> },
];

type KeyStatus = "untested" | "valid" | "invalid";

const KEY_STATUS_BADGE: Record<KeyStatus, React.ReactNode> = {
  valid: (
    <Badge variant="success" dot>
      Verified
    </Badge>
  ),
  invalid: <Badge variant="danger">Not verified</Badge>,
  untested: <Badge variant="neutral">Not tested</Badge>,
};

/** One credential row: name, purpose, status, masked input and actions. */
const ApiKeyRow: React.FC<{
  name: string;
  purpose: string;
  status: KeyStatus;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onTest: () => void;
  isTesting: boolean;
  onOpenDashboard: () => void;
}> = ({
  name,
  purpose,
  status,
  value,
  placeholder,
  onChange,
  onTest,
  isTesting,
  onOpenDashboard,
}) => {
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-2.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {name}
            </span>
            {KEY_STATUS_BADGE[status]}
          </div>
          <p className="mt-0.5 text-xs text-muted">{purpose}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={<ExternalLink />}
          onClick={onOpenDashboard}
        >
          Get key
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <InputGroup variant="secondary" fullWidth className="min-w-0 flex-1">
          <InputGroup.Input
            type={visible ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            aria-label={`${name} API key`}
            className="font-mono"
          />
          <InputGroup.Suffix>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={visible ? <EyeOff /> : <Eye />}
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? "Hide key" : "Show key"}
              title={visible ? "Hide key" : "Show key"}
            />
          </InputGroup.Suffix>
        </InputGroup>
        <Button variant="secondary" isLoading={isTesting} onClick={onTest}>
          Test
        </Button>
      </div>
    </div>
  );
};

/** Label/description on the left, control on the right. */
const SettingRow: React.FC<{
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ title, description, children }) => (
  <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
    <div className="min-w-0 flex-1 basis-56">
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && (
        <div className="mt-0.5 text-xs leading-relaxed text-muted">
          {description}
        </div>
      )}
    </div>
    {children && <div className="flex max-w-full flex-wrap items-center gap-2">{children}</div>}
  </div>
);

/** Small preview tile drawn in the target theme's own colors. */
const ThemePreview: React.FC<{ mode: ColorMode }> = ({ mode }) => {
  const pane = (dark: boolean) => (
    <div
      className={`flex h-full flex-1 gap-1 p-1.5 ${dark ? "bg-[#141416]" : "bg-[#f6f6f7]"}`}
    >
      <div
        className={`w-1/4 space-y-1 rounded-[3px] p-1 ${dark ? "bg-[#0f0f11]" : "bg-[#ececee]"}`}
      >
        <div className={`h-1 rounded-full ${dark ? "bg-white/25" : "bg-black/20"}`} />
        <div className={`h-1 w-2/3 rounded-full ${dark ? "bg-white/15" : "bg-black/10"}`} />
      </div>
      <div
        className={`flex-1 space-y-1 rounded-[3px] border p-1.5 ${dark ? "border-white/10 bg-[#1b1b1e]" : "border-black/8 bg-white"}`}
      >
        <div className={`h-1 w-1/2 rounded-full ${dark ? "bg-white/30" : "bg-black/25"}`} />
        <div className={`h-1 w-3/4 rounded-full ${dark ? "bg-white/12" : "bg-black/8"}`} />
        <div className="mt-1.5 h-1.5 w-6 rounded-[2px] bg-[#6366f1]" />
      </div>
    </div>
  );
  return (
    <div className="flex h-20 overflow-hidden rounded-md border border-border">
      {mode === "system" ? (
        <>
          {pane(false)}
          {pane(true)}
        </>
      ) : (
        pane(mode === "dark")
      )}
    </div>
  );
};

export const SettingsView: React.FC<SettingsViewProps> = ({
  transcriptionProvider,
  onTranscriptionProviderChange,
  zernioKey,
  onSaveZernioKey,
  elevenLabsKey,
  onSaveElevenLabsKey,
  youtubeKey,
  onSaveYoutubeKey,
  onTriggerToast,
  tools = [],
  isLoadingClis = false,
  onRefreshClis = () => {},
  onToggleTool = () => {},
  onRemoveTool = () => {},
  onAddCustomTool = async () => {},
  onRunCommand = async () => ({
    success: true,
    code: 0,
    stdout: "",
    stderr: "",
    fallback_used: false,
  }),
  activeSubTab: controlledSubTab,
  onSubTabChange,
  colorMode,
  onColorModeChange,
  channelProfiles,
  defaultChannelId,
  onSaveChannelProfiles,
  onResetAllData = () => {},
  storageScope = EMPTY_STORAGE_SCOPE,
  onStorageCleaned = () => {},
}) => {
  const [internalSubTab, setInternalSubTab] = useState<SettingsSubTab>("clis");
  const currentSubTab = controlledSubTab ?? internalSubTab;

  const handleTabChange = (tab: SettingsSubTab) => {
    if (onSubTabChange) {
      onSubTabChange(tab);
    } else {
      setInternalSubTab(tab);
    }
  };

  const [zKey, setZKey] = useState(zernioKey);
  const [elKey, setElKey] = useState(elevenLabsKey);
  const [ytKey, setYtKey] = useState(youtubeKey);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  // Draft inputs follow the saved props when they change outside this view
  // (e.g. a key saved from Social, or the trim applied by our own Save).
  useEffect(() => {
    setZKey(zernioKey);
  }, [zernioKey]);
  useEffect(() => {
    setElKey(elevenLabsKey);
  }, [elevenLabsKey]);
  useEffect(() => {
    setYtKey(youtubeKey);
  }, [youtubeKey]);

  const [testingZernio, setTestingZernio] = useState(false);
  const [testingElevenLabs, setTestingElevenLabs] = useState(false);
  const [testingYoutube, setTestingYoutube] = useState(false);

  const [confirmingReset, setConfirmingReset] = useState(false);

  // Transcription readiness: what analysis would use, refreshed with the
  // saved key. Null while probing or when the probe itself fails.
  const [transcription, setTranscription] =
    useState<TranscriptionStatus | null>(null);
  const [isProbingStt, setIsProbingStt] = useState(false);

  // Probes resolve out of order (spawning the interpreter is slow), so a
  // stale probe with the previous key must never overwrite a newer result.
  // Without this, a slow mount-time probe with the old empty key can land
  // after the post-save probe and flip Engine back to "Missing".
  const probeGuardRef = useRef(createLatestGuard());

  const refreshTranscription = async (key: string, announce = false) => {
    const requestId = probeGuardRef.current.next();
    setIsProbingStt(true);
    try {
      const status = await probeTranscription(key, transcriptionProvider);
      if (!probeGuardRef.current.isLatest(requestId)) return;
      setTranscription(status);
      if (announce) notify(status.active_engine === "none" ? "Transcription setup required" : "Transcription ready", status.active_engine === "none" ? "Configure the selected provider and install FFmpeg, then recheck." : `Using ${status.active_engine === "local" ? "local Whisper" : "ElevenLabs Scribe"}.`, status.active_engine === "none" ? "warning" : "success");
    } catch (error) {
      if (!probeGuardRef.current.isLatest(requestId)) return;
      setTranscription(null);
      notify("Engine check failed", error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (probeGuardRef.current.isLatest(requestId)) {
        setIsProbingStt(false);
      }
    }
  };

  useEffect(() => {
    refreshTranscription(elevenLabsKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elevenLabsKey, transcriptionProvider]);

  const [zernioStatus, setZernioStatus] = useState<
    "untested" | "valid" | "invalid"
  >("untested");
  const [elevenLabsStatus, setElevenLabsStatus] = useState<
    "untested" | "valid" | "invalid"
  >("untested");
  const [youtubeStatus, setYoutubeStatus] = useState<
    "untested" | "valid" | "invalid"
  >("untested");

  useEffect(() => { setZernioStatus("untested"); setTestingZernio(false); keyTestGuards.current.zernio.next(); }, [zKey]);
  useEffect(() => { setElevenLabsStatus("untested"); setTestingElevenLabs(false); keyTestGuards.current.elevenlabs.next(); }, [elKey]);
  useEffect(() => { setYoutubeStatus("untested"); setTestingYoutube(false); keyTestGuards.current.youtube.next(); }, [ytKey]);
  const keyTestGuards = useRef({ zernio: createLatestGuard(), elevenlabs: createLatestGuard(), youtube: createLatestGuard() });

  const testKey = async (
    provider: "zernio" | "elevenlabs" | "youtube", value: string,
    setTesting: (testing: boolean) => void, setStatus: (status: KeyStatus) => void,
  ) => {
    if (!value.trim()) {
      onTriggerToast?.("API key required", "Enter a key before testing", "error");
      return;
    }
    const guard = keyTestGuards.current[provider];
    const requestId = guard.next();
    setTesting(true);
    try {
      await validateApiKey(provider, value.trim());
      if (!guard.isLatest(requestId)) return;
      setStatus("valid");
      onTriggerToast?.("Key verified", "The service accepted this API key", "success");
    } catch (error) {
      if (!guard.isLatest(requestId)) return;
      setStatus("invalid");
      onTriggerToast?.("Verification failed", String(error), "error");
    } finally {
      if (guard.isLatest(requestId)) setTesting(false);
    }
  };
  const handleTestZernio = () => testKey("zernio", zKey, setTestingZernio, setZernioStatus);
  const handleTestElevenLabs = () => testKey("elevenlabs", elKey, setTestingElevenLabs, setElevenLabsStatus);
  const handleTestYoutube = () => testKey("youtube", ytKey, setTestingYoutube, setYoutubeStatus);

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setIsSaving(true);
    setIsSaved(false);
    try {
      await onSaveZernioKey(zKey.trim());
      await onSaveElevenLabsKey(elKey.trim());
      await onSaveYoutubeKey(ytKey.trim());
      void refreshTranscription(elKey.trim());
      setIsSaved(true);
      onTriggerToast?.("Preferences saved", isTauri() ? "API keys saved in the system credential store" : "API keys kept for this preview session", "success");
      setTimeout(() => setIsSaved(false), 2500);
    } catch (error) {
      onTriggerToast?.("Save failed", String(error), "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenDashboard = async (url: string) => {
    try {
      await openExternalUrl(url);
    } catch (err: unknown) {
      onTriggerToast?.(
        "Couldn't open browser",
        err instanceof Error ? err.message : url,
        "error",
      );
    }
  };

  const availableCliCount = tools.filter(
    (t) => t.is_available && t.is_enabled,
  ).length;
  const totalCliCount = tools.length;

  // Engine reports on the SAVED key (what analysis actually uses), so when
  // the typed draft differs, say so instead of silently showing "Missing".
  const hasUnsavedElevenLabsEdit = isUnsavedEdit(elKey, elevenLabsKey);


  const section = SETTINGS_NAV.find((s) => s.id === currentSubTab) ?? SETTINGS_NAV[0];

  const engineCheck = (ok: boolean, label: string, detail: string) => (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <span className="flex items-center gap-2 text-sm text-foreground">
        <span
          className={`flex size-4 items-center justify-center rounded-full ${
            ok ? "bg-success/15 text-success" : "bg-surface-tertiary text-muted"
          }`}
        >
          {ok ? (
            <Check className="size-2.5" strokeWidth={3.5} />
          ) : (
            <span className="size-1 rounded-full bg-current" />
          )}
        </span>
        {label}
      </span>
      <span className={`text-xs ${ok ? "text-muted" : "text-warning"}`}>
        {detail}
      </span>
    </li>
  );

  return (
    <div className="space-y-6">
    <PageHeader
      title="Settings"
      description="Tools, API keys, channel and engine"
    />
    <div className="settings-layout grid items-start gap-6 border-t border-separator pt-6">
      <Tabs
        orientation="vertical"
        selectedKey={currentSubTab}
        onSelectionChange={(key) =>
          handleTabChange(String(key) as typeof currentSubTab)
        }
        className="settings-navigation w-full"
      >
        <Tabs.ListContainer className="w-full">
          <Tabs.List aria-label="Settings sections" className="w-full">
            {SETTINGS_NAV.map((item) => (
              <Tabs.Tab
                key={item.id}
                id={item.id}
                className="justify-start gap-2.5 [&_svg]:size-4"
              >
                {item.icon}
                <span className="min-w-0 flex-1 truncate text-start">
                  {item.label}
                </span>
                {item.id === "clis" && (
                  <span className="tabular-nums text-xs text-muted">
                    {availableCliCount}/{totalCliCount}
                  </span>
                )}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      <div className="settings-content min-w-0">
        <div className="mb-5">
          <h2 className="text-base font-semibold text-foreground">
            {section.label}
          </h2>
          <p className="mt-0.5 text-sm text-muted">{section.description}</p>
        </div>

        <div className={currentSubTab === "clis" ? "min-w-0" : "hidden"}>
          <CliManager
            tools={tools}
            isLoading={isLoadingClis}
            onRefresh={onRefreshClis}
            onToggleTool={onToggleTool}
            onRemoveTool={onRemoveTool}
            onAddCustomTool={onAddCustomTool}
            onRunCommand={onRunCommand}
          />
        </div>

        <div className={currentSubTab === "keys" ? "min-w-0" : "hidden"}>
          <form onSubmit={handleSave} className="max-w-3xl">
            <SectionCard
              title="Credentials"
              description={isTauri() ? "Saved in the system credential store; sent to the matching service when used" : "Browser preview: keys stay in memory for this session"}
              contentClassName="p-0 divide-y divide-separator"
              footer={
                <div className="flex w-full items-center justify-between gap-3">
                  <span
                    className={`flex items-center gap-1.5 text-xs ${isSaved ? "font-medium text-success" : "text-muted"}`}
                  >
                    {isSaved && <Check className="size-3.5" strokeWidth={3} />}
                    {isSaved ? "Saved" : "Changes apply after saving"}
                  </span>
                  <Button type="submit" variant="primary" isLoading={isSaving}>
                    Save keys
                  </Button>
                </div>
              }
            >
              <ApiKeyRow
                name="Zernio"
                purpose="Publish and schedule shorts to TikTok, YouTube, Reels and X."
                status={zernioStatus}
                value={zKey}
                placeholder="zr_live_…"
                onChange={(v) => {
                  setZKey(v);
                  setZernioStatus("untested");
                }}
                onTest={handleTestZernio}
                isTesting={testingZernio}
                onOpenDashboard={() =>
                  handleOpenDashboard("https://zernio.com/app/settings/api-keys")
                }
              />
              <ApiKeyRow
                name="ElevenLabs Scribe"
                purpose="Speech-to-Text access for Scribe. Used when ElevenLabs is selected under Engine."
                status={elevenLabsStatus}
                value={elKey}
                placeholder="sk_…"
                onChange={(v) => {
                  setElKey(v);
                  setElevenLabsStatus("untested");
                }}
                onTest={handleTestElevenLabs}
                isTesting={testingElevenLabs}
                onOpenDashboard={() =>
                  handleOpenDashboard("https://elevenlabs.io/app/settings/api-keys")
                }
              />
              <ApiKeyRow
                name="YouTube Data API"
                purpose="Trending Shorts keywords used to boost tags."
                status={youtubeStatus}
                value={ytKey}
                placeholder="AIza…"
                onChange={(v) => {
                  setYtKey(v);
                  setYoutubeStatus("untested");
                }}
                onTest={handleTestYoutube}
                isTesting={testingYoutube}
                onOpenDashboard={() =>
                  handleOpenDashboard(
                    "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
                  )
                }
              />
            </SectionCard>
          </form>
        </div>

        <div className={currentSubTab === "appearance" ? "min-w-0" : "hidden"}>
          <div className="max-w-3xl">
            <SectionCard title="Theme" description="Applied instantly">
              <div
                className="grid grid-cols-1 gap-3 sm:grid-cols-3"
                role="radiogroup"
                aria-label="Color mode"
              >
                {MODE_CARDS.map((mode) => {
                  const isSelected = colorMode === mode.id;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => onColorModeChange(mode.id)}
                      className={`rounded-lg border p-2 text-left transition-colors ${
                        isSelected
                          ? "border-accent ring-2 ring-accent/20"
                          : "border-border hover:border-border-tertiary"
                      }`}
                    >
                      <ThemePreview mode={mode.id} />
                      <span className="mt-2 flex items-center gap-1.5 px-0.5 text-sm font-medium text-foreground">
                        <span className="text-muted">{mode.icon}</span>
                        {mode.name}
                        {isSelected && (
                          <Check className="ml-auto size-3.5 text-accent" strokeWidth={3} />
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </SectionCard>
          </div>
        </div>

        <div className={currentSubTab === "channel" ? "min-w-0" : "hidden"}>
          <ChannelProfiles
            profiles={channelProfiles}
            defaultId={defaultChannelId}
            onSave={onSaveChannelProfiles}
          />
        </div>

        {currentSubTab === "storage" && (
          <div className="min-w-0">
            <StorageSettings scope={storageScope} onCleaned={onStorageCleaned} onTriggerToast={onTriggerToast} />
          </div>
        )}

        <div className={currentSubTab === "engine" ? "min-w-0" : "hidden"}>
          <div className="max-w-3xl space-y-5">
            <SectionCard
              title="Transcription"
              description={
                !isTauri() ? "Provider saved here; engine availability is checked in the desktop app." : transcription
                  ? transcription.active_engine === "elevenlabs"
                    ? "Using ElevenLabs Scribe"
                    : transcription.active_engine === "local"
                      ? `Using local faster-whisper (${transcription.local_model})`
                      : "No engine configured"
                  : isProbingStt
                    ? "Checking engines…"
                    : "Status unavailable"
              }
              contentClassName="p-0"
              actions={
                <Button
                  variant="ghost"
                  icon={<RefreshCw />}
                  isLoading={isProbingStt}
                  onClick={() => {
                    if (hasUnsavedElevenLabsEdit) notify("Unsaved API key", "Save your key under API keys, then recheck.", "warning");
                    void refreshTranscription(elevenLabsKey, true);
                  }}
                  title="Re-check transcription engines"
                >
                  Recheck
                </Button>
              }
            >
              <div className="space-y-3 py-4">
                <Segmented<TranscriptionProvider>
                  label="Transcription provider"
                  value={transcriptionProvider}
                  onChange={(provider) => {
                    onTranscriptionProviderChange(provider);
                    if (provider === "elevenlabs" && !elevenLabsKey.trim()) notify("ElevenLabs API key required", "Save a key with Speech-to-Text access in Settings → API keys.", "warning");
                    else notify("Transcription provider saved", provider === "local" ? "Using local Whisper for new transcription jobs." : "Using ElevenLabs for new transcription jobs.", "success");
                  }}
                  options={[{ value: "local", label: "Local Whisper" }, { value: "elevenlabs", label: "ElevenLabs API" }]}
                  fill
                />
                <p className="text-xs leading-relaxed text-muted">
                  {transcriptionProvider === "local"
                    ? "Transcribes on this device with the installed Whisper model. No transcription API charges or audio uploads."
                    : "Uploads extracted audio to ElevenLabs Scribe using your saved API key and account allowance. Free credits and limits depend on your ElevenLabs account."}
                </p>
                <p className="text-xs leading-relaxed text-muted">Saved automatically. Applies to captions, video analysis and YouTube audio transcription. Available YouTube captions are reused first. Provider failures are reported without switching providers.</p>
              </div>
              {transcriptionProvider === "local" && <p className="py-2 text-xs text-muted">Install local transcription: <code className="select-all">cd video-use &amp;&amp; ./setup_local_stt.sh --managed</code></p>}
              {!isTauri() ? (
                <p className="py-3 text-xs text-muted">Open the desktop app to check the local model, FFmpeg and saved API key.</p>
              ) : transcription ? (
                <>
                  <ul className="divide-y divide-separator">
                    {transcriptionProvider === "elevenlabs" ? engineCheck(
                      transcription.elevenlabs_key_configured,
                      "ElevenLabs API key",
                      transcription.elevenlabs_key_configured
                        ? "Saved"
                        : "Missing — add under API keys",
                    ) : engineCheck(
                      transcription.local_available,
                      "Local faster-whisper",
                      transcription.local_available ? `Installed · ${transcription.local_model}` : "Not installed",
                    )}
                    {engineCheck(
                      transcription.ffmpeg_available,
                      "FFmpeg audio extraction",
                      transcription.ffmpeg_available ? "Available" : "Missing",
                    )}
                  </ul>
                </>
              ) : (
                <p className="py-3 text-xs text-muted">
                  {isProbingStt
                    ? "Checking transcription engines…"
                    : "Engine status unavailable — press Recheck."}
                </p>
              )}
            </SectionCard>

            <SectionCard title="Processing" contentClassName="p-0">
              <SettingRow
                title="Local-first"
                description="Encoding, silence detection and caption burn-in run on this machine. ElevenLabs transcription uploads audio when selected; AI editing tools may send transcript text to their provider. Publishing uploads the finished short."
              />
            </SectionCard>

            <section className="rounded-3xl border border-danger/30 bg-surface shadow-surface">
              <SettingRow
                title="Reset all local data"
                description="Removes API keys, the post queue, render history, studio projects, channel profiles and sidebar state, then reloads. Cannot be undone."
              >
                {confirmingReset ? (
                  <>
                    <Button variant="ghost" onClick={() => setConfirmingReset(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        setConfirmingReset(false);
                        onResetAllData();
                      }}
                    >
                      Yes, reset everything
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="danger-soft"
                    onClick={() => setConfirmingReset(true)}
                  >
                    Reset…
                  </Button>
                )}
              </SettingRow>
            </section>
          </div>
        </div>
      </div>
    </div>
    </div>
  );
};
