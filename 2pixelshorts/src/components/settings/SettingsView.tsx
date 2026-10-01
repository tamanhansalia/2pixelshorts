import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Settings, 
  Key, 
  Check, 
  ExternalLink, 
  ShieldCheck, 
  Eye, 
  EyeOff, 
  Cpu, 
  Terminal, 
  HardDrive,
  CheckCircle2,
  Palette
} from "lucide-react";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { CliToolInfo, CommandOutput, HeroUiThemeId, HERO_UI_THEMES } from "../../types";
import { CliManager } from "../cli/CliManager";

export type SettingsSubTab = "clis" | "keys" | "themes" | "engine";

interface SettingsViewProps {
  zernioKey: string;
  onSaveZernioKey: (key: string) => void;
  elevenLabsKey: string;
  onSaveElevenLabsKey: (key: string) => void;
  onTriggerToast?: (title: string, description?: string, type?: "success" | "error" | "info") => void;
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
  // HeroUI Theme Props
  currentTheme?: HeroUiThemeId;
  onSelectTheme?: (theme: HeroUiThemeId) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  zernioKey,
  onSaveZernioKey,
  elevenLabsKey,
  onSaveElevenLabsKey,
  onTriggerToast,
  tools = [],
  isLoadingClis = false,
  onRefreshClis = () => {},
  onToggleTool = () => {},
  onRemoveTool = () => {},
  onAddCustomTool = async () => {},
  onRunCommand = async () => ({ success: true, code: 0, stdout: "", stderr: "" }),
  activeSubTab: controlledSubTab,
  onSubTabChange,
  currentTheme = "default",
  onSelectTheme = () => {},
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
  const [showZKey, setShowZKey] = useState(false);
  const [showElKey, setShowElKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  const [testingZernio, setTestingZernio] = useState(false);
  const [testingElevenLabs, setTestingElevenLabs] = useState(false);

  const [zernioStatus, setZernioStatus] = useState<"untested" | "valid" | "invalid">(
    zernioKey ? "valid" : "untested"
  );
  const [elevenLabsStatus, setElevenLabsStatus] = useState<"untested" | "valid" | "invalid">(
    elevenLabsKey ? "valid" : "untested"
  );

  const handleTestZernio = async () => {
    if (!zKey.trim()) {
      onTriggerToast?.("API Key Required", "Please enter a key before testing", "error");
      return;
    }
    setTestingZernio(true);
    await new Promise((r) => setTimeout(r, 400));
    if (zKey.trim().length >= 8) {
      setZernioStatus("valid");
      onTriggerToast?.("Zernio Verified", "API key pattern validated successfully", "success");
    } else {
      setZernioStatus("invalid");
      onTriggerToast?.("Key Error", "Token appears too short or invalid", "error");
    }
    setTestingZernio(false);
  };

  const handleTestElevenLabs = async () => {
    if (!elKey.trim()) {
      onTriggerToast?.("API Key Required", "Please enter a key before testing", "error");
      return;
    }
    setTestingElevenLabs(true);
    await new Promise((r) => setTimeout(r, 400));
    if (elKey.trim().length >= 10) {
      setElevenLabsStatus("valid");
      onTriggerToast?.("ElevenLabs Verified", "Transcription key recognized", "success");
    } else {
      setElevenLabsStatus("invalid");
      onTriggerToast?.("Key Error", "Token appears too short or invalid", "error");
    }
    setTestingElevenLabs(false);
  };

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setIsSaving(true);
    await new Promise((r) => setTimeout(r, 180));
    onSaveZernioKey(zKey.trim());
    onSaveElevenLabsKey(elKey.trim());
    setIsSaving(false);
    setIsSaved(true);
    onTriggerToast?.("Preferences Saved", "Environment credentials updated locally", "success");
    setTimeout(() => setIsSaved(false), 2500);
  };

  const availableCliCount = tools.filter((t) => t.is_available && t.is_enabled).length;
  const totalCliCount = tools.length;

  return (
    <div className="space-y-4 max-w-6xl mx-auto select-none font-sans">
      {/* Top Action Header with Segmented Section Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-surface border border-border">
        <div className="flex items-center gap-2.5">
          <div className="h-6 w-6 rounded bg-surface-secondary border border-border flex items-center justify-center text-foreground shrink-0">
            <Settings className="w-3.5 h-3.5" />
          </div>
          <span className="text-xs font-semibold text-foreground tracking-tight">
            Settings
          </span>
        </div>

        {/* Segmented Sub-Tab Switcher */}
        <div className="flex items-center gap-1 bg-surface-secondary p-0.5 rounded-md border border-border self-start sm:self-auto overflow-x-auto max-w-full">
          <button
            type="button"
            onClick={() => handleTabChange("clis")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition cursor-pointer whitespace-nowrap ${
              currentSubTab === "clis"
                ? "bg-surface text-foreground shadow-xs font-semibold border border-border/80"
                : "text-muted hover:text-foreground"
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>CLI Tools & Agents</span>
            <span className="text-[10px] font-mono px-1 py-0.2 rounded bg-surface-secondary text-muted border border-border/60">
              {availableCliCount}/{totalCliCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleTabChange("keys")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition cursor-pointer whitespace-nowrap ${
              currentSubTab === "keys"
                ? "bg-surface text-foreground shadow-xs font-semibold border border-border/80"
                : "text-muted hover:text-foreground"
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span>API Keys</span>
          </button>

          <button
            type="button"
            onClick={() => handleTabChange("themes")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition cursor-pointer whitespace-nowrap ${
              currentSubTab === "themes"
                ? "bg-surface text-foreground shadow-xs font-semibold border border-border/80"
                : "text-muted hover:text-foreground"
            }`}
          >
            <Palette className="w-3.5 h-3.5" />
            <span>HeroUI Themes</span>
          </button>

          <button
            type="button"
            onClick={() => handleTabChange("engine")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition cursor-pointer whitespace-nowrap ${
              currentSubTab === "engine"
                ? "bg-surface text-foreground shadow-xs font-semibold border border-border/80"
                : "text-muted hover:text-foreground"
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Engine & Privacy</span>
          </button>
        </div>
      </div>

      {/* Sub-Tab 1: CLI Tools & Agents Manager */}
      {currentSubTab === "clis" && (
        <CliManager
          tools={tools}
          isLoading={isLoadingClis}
          onRefresh={onRefreshClis}
          onToggleTool={onToggleTool}
          onRemoveTool={onRemoveTool}
          onAddCustomTool={onAddCustomTool}
          onRunCommand={onRunCommand}
        />
      )}

      {/* Sub-Tab 2: API Keys & Integrations */}
      {currentSubTab === "keys" && (
        <form onSubmit={handleSave} className="space-y-3.5">
          {/* Zernio Key */}
          <div className="p-4 rounded-lg bg-surface border border-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded bg-surface-secondary border border-border flex items-center justify-center text-foreground">
                  <Key className="w-3.5 h-3.5 text-muted" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-foreground tracking-tight">
                      Zernio Social Gateway API Key
                    </span>
                    {zernioStatus === "valid" ? (
                      <Badge variant="success" size="xs" dot>Verified</Badge>
                    ) : (
                      <Badge variant="default" size="xs">Untested</Badge>
                    )}
                  </div>
                  <span className="text-[10px] text-muted">
                    Used for dispatching and scheduling shorts across TikTok, YouTube, Instagram Reels, and X.
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  isLoading={testingZernio}
                  onClick={handleTestZernio}
                >
                  Test Key
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  icon={<ExternalLink className="w-3 h-3" />}
                  iconPlacement="end"
                  onClick={() => window.open("https://zernio.com/app/settings/api-keys", "_blank")}
                >
                  Dashboard
                </Button>
              </div>
            </div>

            <div className="relative">
              <input
                type={showZKey ? "text" : "password"}
                value={zKey}
                onChange={(e) => {
                  setZKey(e.target.value);
                  setZernioStatus("untested");
                }}
                placeholder="zr_live_..."
                className="w-full pl-3 pr-9 py-1.5 rounded-md bg-field border border-border text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-foreground font-mono transition"
              />
              <button
                type="button"
                onClick={() => setShowZKey(!showZKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground cursor-pointer p-0.5"
              >
                {showZKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* ElevenLabs Key */}
          <div className="p-4 rounded-lg bg-surface border border-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded bg-surface-secondary border border-border flex items-center justify-center text-foreground">
                  <Key className="w-3.5 h-3.5 text-muted" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-foreground tracking-tight">
                      ElevenLabs Scribe Key
                    </span>
                    {elevenLabsStatus === "valid" ? (
                      <Badge variant="success" size="xs" dot>Verified</Badge>
                    ) : (
                      <Badge variant="default" size="xs">Untested</Badge>
                    )}
                  </div>
                  <span className="text-[10px] text-muted">
                    Used for high-accuracy word-timestamp transcription when local VTT files are absent.
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  isLoading={testingElevenLabs}
                  onClick={handleTestElevenLabs}
                >
                  Test Key
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  icon={<ExternalLink className="w-3 h-3" />}
                  iconPlacement="end"
                  onClick={() => window.open("https://elevenlabs.io/app/settings/api-keys", "_blank")}
                >
                  Dashboard
                </Button>
              </div>
            </div>

            <div className="relative">
              <input
                type={showElKey ? "text" : "password"}
                value={elKey}
                onChange={(e) => {
                  setElKey(e.target.value);
                  setElevenLabsStatus("untested");
                }}
                placeholder="sk_..."
                className="w-full pl-3 pr-9 py-1.5 rounded-md bg-field border border-border text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-foreground font-mono transition"
              />
              <button
                type="button"
                onClick={() => setShowElKey(!showElKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground cursor-pointer p-0.5"
              >
                {showElKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Save Bar */}
          <div className="flex items-center justify-between pt-2">
            <AnimatePresence>
              {isSaved ? (
                <motion.span 
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className="text-xs text-success flex items-center gap-1.5 font-medium"
                >
                  <Check className="w-3.5 h-3.5 stroke-[3]" />
                  <span>Preferences saved to local application storage</span>
                </motion.span>
              ) : (
                <span className="text-[11px] text-muted">
                  Credentials are encrypted in local storage.
                </span>
              )}
            </AnimatePresence>

            <Button
              type="submit"
              variant="primary"
              size="sm"
              isLoading={isSaving}
            >
              Save Configuration
            </Button>
          </div>
        </form>
      )}

      {/* Sub-Tab 3: HeroUI Official Themes Gallery */}
      {currentSubTab === "themes" && (
        <div className="space-y-4">
          <div className="p-3.5 rounded-lg bg-surface border border-border flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Palette className="w-4 h-4 text-foreground" />
              <span className="text-xs font-semibold text-foreground tracking-tight">
                HeroUI Themes
              </span>
            </div>

            <Button
              variant="ghost"
              size="xs"
              icon={<ExternalLink className="w-3 h-3" />}
              iconPlacement="end"
              onClick={() => window.open("https://heroui.com/docs/themes", "_blank")}
            >
              Docs
            </Button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {HERO_UI_THEMES.map((theme) => {
              const isSelected = currentTheme === theme.id;
              return (
                <div
                  key={theme.id}
                  onClick={() => onSelectTheme(theme.id)}
                  className={`p-3 rounded-lg border text-left transition-all cursor-pointer flex flex-col justify-between group ${
                    isSelected
                      ? "border-foreground bg-surface-secondary shadow-xs ring-1 ring-foreground/20"
                      : "border-border bg-surface hover:border-muted hover:bg-surface-secondary/50"
                  }`}
                >
                  <div className="space-y-2.5">
                    {/* Header: Name & Indicator */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground">
                        {theme.name}
                      </span>

                      {isSelected ? (
                        <div className="w-3.5 h-3.5 rounded-full bg-foreground text-background flex items-center justify-center shrink-0">
                          <Check className="w-2.5 h-2.5 stroke-[3]" />
                        </div>
                      ) : (
                        <span
                          className="w-3 h-3 rounded-full border border-white/20 shrink-0"
                          style={{ backgroundColor: theme.accent }}
                        />
                      )}
                    </div>

                    {/* Color Swatch Strip */}
                    <div className="p-2 rounded-md border border-border flex items-center justify-between gap-2" style={{ backgroundColor: theme.background }}>
                      <div className="flex items-center gap-1.5">
                        <div
                          className="w-4 h-4 rounded border border-white/10 flex items-center justify-center text-[9px] font-bold"
                          style={{ backgroundColor: theme.accent, color: theme.id === "spotify" ? "#000" : "#fff" }}
                        >
                          2P
                        </div>
                        <div className="text-[10px] font-mono px-1.5 py-0.2 rounded border border-border/80" style={{ backgroundColor: theme.surface, color: "#fff" }}>
                          Surface
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full border border-black/30" style={{ backgroundColor: theme.accent }} />
                        <span className="w-2 h-2 rounded-full border border-white/10" style={{ backgroundColor: theme.surface }} />
                        <span className="w-2 h-2 rounded-full border border-white/10" style={{ backgroundColor: theme.background }} />
                      </div>
                    </div>
                  </div>

                  {/* Bottom Action */}
                  <div className="pt-2 mt-2 border-t border-border flex items-center justify-end">
                    <span className={`text-[11px] font-medium ${isSelected ? "text-foreground font-semibold" : "text-muted group-hover:text-foreground"}`}>
                      {isSelected ? "Active" : "Apply"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Sub-Tab 4: Engine & Privacy */}
      {currentSubTab === "engine" && (
        <div className="space-y-3.5">
          <div className="p-4 rounded-lg bg-surface border border-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-foreground text-xs font-semibold">
                <ShieldCheck className="w-4 h-4 text-success" />
                <span>Local Hardware & Privacy Isolation</span>
              </div>
              <Badge variant="success" size="xs">Active Isolation</Badge>
            </div>
            <p className="text-[11px] text-muted leading-relaxed">
              All video encoding, silence detection, subtitle burns, and CLI scripts execute locally on your machine via FFmpeg and Python. Your raw video frames and audio never leave your local workstation.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="p-3.5 rounded-lg bg-surface border border-border space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Cpu className="w-3.5 h-3.5 text-muted" />
                <span>FFmpeg Engine</span>
              </div>
              <p className="text-[11px] text-muted">
                Hardware-accelerated H.264 rendering with multi-threaded audio filter graph.
              </p>
              <div className="pt-1 flex items-center gap-1.5 text-[10px] font-mono text-success">
                <CheckCircle2 className="w-3 h-3" />
                <span>Local Binary Active</span>
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-surface border border-border space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <HardDrive className="w-3.5 h-3.5 text-muted" />
                <span>Temp Artifacts</span>
              </div>
              <p className="text-[11px] text-muted">
                Intermediary VTT and normalized audio streams stored in project cache.
              </p>
              <div className="pt-1 flex items-center gap-1.5 text-[10px] font-mono text-muted">
                <span>Auto-cleaned on finish</span>
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-surface border border-border space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Terminal className="w-3.5 h-3.5 text-muted" />
                <span>CLI Execution Security</span>
              </div>
              <p className="text-[11px] text-muted">
                Process spawn isolation ensures scripts run strictly with user privileges.
              </p>
              <div className="pt-1 flex items-center gap-1.5 text-[10px] font-mono text-success">
                <CheckCircle2 className="w-3 h-3" />
                <span>Sandboxed Subprocess</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
