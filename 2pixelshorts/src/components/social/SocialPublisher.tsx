import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Share2, 
  Send, 
  Clock, 
  Key, 
  Check, 
  ExternalLink, 
  Copy, 
  AlertCircle, 
  RefreshCw, 
  Loader2,
  Film,
  Sparkles,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { SocialPublishPayload, ZernioAccount } from "../../types";
import { LinearProgress } from "../ui/LinearProgress";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";

const YoutubeIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
  </svg>
);

const TwitterIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>
);

const InstagramIcon = () => (
  <svg className="w-3.5 h-3.5 fill-none stroke-current stroke-2" viewBox="0 0 24 24">
    <rect width="20" height="20" x="2" y="2" rx="5" ry="5"/>
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
    <line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>
  </svg>
);

const LinkedinIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/>
  </svg>
);

const FacebookIcon = () => (
  <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
    <path d="M9 8H6v4h3v12h5V12h3.642L18 8h-4V6.333C14 5.374 14.5 5 15.5 5H18V0h-3.8c-3.6 0-5.2 1.8-5.2 4.8V8z"/>
  </svg>
);

const PLATFORMS = [
  { id: "tiktok", name: "TikTok", icon: Share2 },
  { id: "youtube", name: "YouTube Shorts", icon: YoutubeIcon },
  { id: "instagram", name: "Instagram Reels", icon: InstagramIcon },
  { id: "twitter", name: "X / Twitter", icon: TwitterIcon },
  { id: "linkedin", name: "LinkedIn", icon: LinkedinIcon },
  { id: "facebook", name: "Facebook", icon: FacebookIcon },
];

interface SocialPublisherProps {
  apiKey: string;
  onSaveApiKey: (key: string) => void;
  onPublish: (apiKey: string, payload: SocialPublishPayload) => Promise<string>;
  onGetAccounts?: (apiKey: string) => Promise<ZernioAccount[]>;
  onConnectPlatform?: (apiKey: string, platform: string) => Promise<void>;
  initialVideoPath?: string;
  initialTitle?: string;
  initialDescription?: string;
  initialTags?: string[];
}

export const SocialPublisher: React.FC<SocialPublisherProps> = ({
  apiKey,
  onSaveApiKey,
  onPublish,
  onGetAccounts,
  onConnectPlatform,
  initialVideoPath = "final_short.mp4",
  initialTitle,
  initialDescription,
  initialTags: _initialTags,
}) => {
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(["tiktok", "youtube"]);
  const [title, setTitle] = useState(initialTitle || "AI-Automated Short #coding #tech #viral");
  const [description, setDescription] = useState(initialDescription || "Processed with TUARI V2 local AI video pipeline.");
  const [videoPath, setVideoPath] = useState(initialVideoPath);
  const [publishNow, setPublishNow] = useState(true);
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("18:00");
  const [timezone, setTimezone] = useState("Asia/Kolkata");

  const [accounts, setAccounts] = useState<ZernioAccount[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStage, setSubmitStage] = useState<string>("Validating media");
  const [responseMessage, setResponseMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedResponse, setCopiedResponse] = useState(false);

  useEffect(() => {
    if (initialVideoPath) {
      setVideoPath(initialVideoPath);
    }
  }, [initialVideoPath]);

  useEffect(() => {
    if (initialTitle) {
      setTitle(initialTitle);
    }
  }, [initialTitle]);

  useEffect(() => {
    if (initialDescription) {
      setDescription(initialDescription);
    }
  }, [initialDescription]);

  useEffect(() => {
    if (apiKey.trim()) {
      loadAccounts();
    }
  }, [apiKey]);

  const loadAccounts = async () => {
    if (!onGetAccounts || !apiKey.trim()) return;
    setIsLoadingAccounts(true);
    try {
      const list = await onGetAccounts(apiKey.trim());
      setAccounts(list);
      const connectedPlatforms = list
        .filter((a) => a.is_connected)
        .map((a) => a.platform.toLowerCase());
      if (connectedPlatforms.length > 0) {
        setSelectedPlatforms(connectedPlatforms);
      }
    } catch (e) {
      console.error("Failed to load accounts:", e);
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
    setSelectedPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const handleSelectAll = () => {
    if (selectedPlatforms.length === PLATFORMS.length) {
      setSelectedPlatforms([]);
    } else {
      setSelectedPlatforms(PLATFORMS.map((p) => p.id));
    }
  };

  const handleCopyResponse = () => {
    if (!responseMessage) return;
    navigator.clipboard.writeText(responseMessage);
    setCopiedResponse(true);
    setTimeout(() => setCopiedResponse(false), 2000);
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedPlatforms.length === 0) {
      setErrorMessage("Please select at least one social media channel.");
      return;
    }
    if (!apiKey.trim()) {
      setErrorMessage("Zernio API Key is required to publish or schedule posts.");
      setShowApiKeyInput(true);
      return;
    }

    setIsSubmitting(true);
    setSubmitStage("Preparing media payload...");
    setErrorMessage(null);
    setResponseMessage(null);

    try {
      const scheduled_for = !publishNow && scheduledDate
        ? `${scheduledDate}T${scheduledTime}:00`
        : undefined;

      const targetAccountIds = selectedPlatforms.map((p) => {
        const acc = accounts.find((a) => a.platform.toLowerCase() === p);
        return acc ? acc.id : p;
      });

      const payload: SocialPublishPayload = {
        title,
        description,
        platforms: selectedPlatforms,
        video_path: videoPath,
        publish_now: publishNow,
        scheduled_for,
        timezone,
        account_ids: targetAccountIds,
      };

      setSubmitStage("Connecting to Zernio REST Gateway...");
      await new Promise((r) => setTimeout(r, 250));

      setSubmitStage(`Dispatching to ${selectedPlatforms.join(", ")}...`);
      const result = await onPublish(apiKey, payload);
      setResponseMessage(result);
    } catch (err: any) {
      setErrorMessage(err?.toString() || "Publishing failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  const connectedCount = accounts.filter((a) => a.is_connected).length;

  return (
    <div className="space-y-4 max-w-6xl mx-auto select-none font-sans">
      {/* Top Header Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-surface border border-border">
        <div className="flex items-center gap-2.5">
          <div className="h-6 w-6 rounded bg-surface-secondary border border-border flex items-center justify-center text-foreground shrink-0">
            <Share2 className="w-3.5 h-3.5" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground tracking-tight">
              Social Dispatch
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface-secondary text-muted border border-border">
              {connectedCount}/{PLATFORMS.length} channels
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto">
          <button
            type="button"
            onClick={() => setShowApiKeyInput(!showApiKeyInput)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border border-border bg-surface-secondary hover:bg-surface-tertiary text-foreground transition cursor-pointer"
          >
            <Key className="w-3 h-3 text-muted" />
            <span className="text-[11px] font-medium">
              {apiKey.trim() ? "API Key Configured" : "Enter API Key"}
            </span>
            {showApiKeyInput ? <ChevronUp className="w-3 h-3 text-muted" /> : <ChevronDown className="w-3 h-3 text-muted" />}
          </button>

          <Button
            variant="secondary"
            size="xs"
            icon={<RefreshCw className={`w-3 h-3 ${isLoadingAccounts ? "animate-spin" : ""}`} />}
            onClick={loadAccounts}
            isLoading={isLoadingAccounts}
            disabled={!apiKey.trim()}
          >
            Sync
          </Button>

          <Button
            variant="ghost"
            size="xs"
            icon={<ExternalLink className="w-3 h-3" />}
            iconPlacement="end"
            onClick={() => window.open("https://zernio.com/app/accounts", "_blank")}
          >
            Portal
          </Button>
        </div>
      </div>

      {/* Expandable API Key drawer */}
      <AnimatePresence>
        {showApiKeyInput && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="p-3.5 rounded-lg bg-surface border border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
          >
            <div className="flex items-center gap-2">
              <Key className="w-3.5 h-3.5 text-muted" />
              <span className="text-muted font-medium">Zernio REST Gateway Token:</span>
            </div>
            <div className="flex items-center gap-2 flex-1 max-w-md">
              <input
                type="password"
                placeholder="zr_live_..."
                value={apiKey}
                onChange={(e) => onSaveApiKey(e.target.value)}
                className="w-full px-3 py-1.5 rounded-md bg-field border border-border text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-foreground font-mono transition"
              />
              {apiKey.trim() ? (
                <Badge variant="success" size="xs" dot>Active</Badge>
              ) : (
                <Badge variant="default" size="xs">Required</Badge>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 2-Column Desktop Workstation */}
      <form onSubmit={handlePublish} className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left Column: Channels Matrix (5 cols) */}
        <div className="lg:col-span-5 space-y-3">
          <div className="p-3.5 rounded-lg bg-surface border border-border space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-foreground tracking-tight">
                  Target Channels
                </span>
                <span className="text-[11px] text-muted block">
                  {selectedPlatforms.length} selected
                </span>
              </div>
              <button
                type="button"
                onClick={handleSelectAll}
                className="text-[11px] text-muted hover:text-foreground transition cursor-pointer"
              >
                {selectedPlatforms.length === PLATFORMS.length ? "Deselect All" : "Select All"}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-2">
              {PLATFORMS.map((platform) => {
                const Icon = platform.icon;
                const isSelected = selectedPlatforms.includes(platform.id);
                const acc = accounts.find((a) => a.platform.toLowerCase() === platform.id);
                const isConnected = acc?.is_connected ?? (platform.id === "tiktok" || platform.id === "youtube");
                const isConnecting = connectingPlatform === platform.id;

                return (
                  <div
                    key={platform.id}
                    onClick={() => togglePlatform(platform.id)}
                    className={`p-3 rounded-md border flex items-center justify-between gap-3 cursor-pointer transition-all ${
                      isSelected
                        ? "bg-surface-secondary border-foreground/80 shadow-xs"
                        : "bg-surface-secondary/40 border-border hover:border-muted/80"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={`p-1.5 rounded ${isSelected ? "bg-foreground text-background" : "bg-surface border border-border text-foreground"}`}>
                        <Icon />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-foreground truncate">
                          {platform.name}
                        </div>
                        <div className="text-[10px] text-muted font-mono truncate">
                          {acc?.username || (isConnected ? "@TUARIStudio" : "Unlinked")}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {isConnected ? (
                        <div className={`h-4 w-4 rounded flex items-center justify-center border transition-colors ${
                          isSelected ? "bg-foreground text-background border-foreground" : "border-border bg-surface"
                        }`}>
                          {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleConnect(platform.id);
                          }}
                          className="text-[10px] text-muted hover:text-foreground underline cursor-pointer"
                        >
                          {isConnecting ? "Connecting..." : "Link"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Column: Payload & Distribution Settings (7 cols) */}
        <div className="lg:col-span-7 space-y-3">
          {/* Post Details Card */}
          <div className="p-4 rounded-lg bg-surface border border-border space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground tracking-tight flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-foreground" />
                Post Content & Metadata
              </span>
              <span className="text-[10px] text-muted font-mono">
                {title.length}/100 chars
              </span>
            </div>

            <div className="space-y-2.5">
              <div>
                <label className="block text-[11px] font-medium text-foreground mb-1">
                  Post Title & Hashtags
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Title and hashtags..."
                  className="w-full px-2.5 py-1.5 rounded-md text-xs bg-field border border-border text-foreground placeholder:text-muted focus:outline-none focus:border-foreground transition"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-foreground mb-1">
                  Description & Caption
                </label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Caption for social channels..."
                  className="w-full px-2.5 py-1.5 rounded-md text-xs bg-field border border-border text-foreground placeholder:text-muted focus:outline-none focus:border-foreground transition"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-foreground mb-1">
                  Video File Location
                </label>
                <div className="relative">
                  <Film className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                  <input
                    type="text"
                    value={videoPath}
                    onChange={(e) => setVideoPath(e.target.value)}
                    placeholder="final_short.mp4"
                    className="w-full pl-8 pr-2.5 py-1.5 rounded-md text-xs bg-field border border-border text-foreground placeholder:text-muted focus:outline-none focus:border-foreground font-mono transition"
                    required
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Schedule & Timing Card */}
          <div className="p-4 rounded-lg bg-surface border border-border space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground tracking-tight flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-foreground" />
                Distribution Timing
              </span>
              <div className="flex items-center gap-1 bg-surface-secondary p-0.5 rounded-md border border-border text-xs">
                <button
                  type="button"
                  onClick={() => setPublishNow(true)}
                  className={`px-2.5 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
                    publishNow ? "bg-surface text-foreground font-semibold border border-border shadow-xs" : "text-muted hover:text-foreground"
                  }`}
                >
                  Publish Now
                </button>
                <button
                  type="button"
                  onClick={() => setPublishNow(false)}
                  className={`px-2.5 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
                    !publishNow ? "bg-surface text-foreground font-semibold border border-border shadow-xs" : "text-muted hover:text-foreground"
                  }`}
                >
                  Schedule Later
                </button>
              </div>
            </div>

            {!publishNow && (
              <motion.div 
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-xs"
              >
                <div>
                  <label className="block text-[10px] text-muted mb-1">Release Date</label>
                  <input
                    type="date"
                    value={scheduledDate}
                    onChange={(e) => setScheduledDate(e.target.value)}
                    className="w-full px-2.5 py-1 rounded-md bg-field border border-border text-xs text-foreground focus:outline-none focus:border-foreground transition"
                    required={!publishNow}
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-muted mb-1">Release Time</label>
                  <input
                    type="time"
                    value={scheduledTime}
                    onChange={(e) => setScheduledTime(e.target.value)}
                    className="w-full px-2.5 py-1 rounded-md bg-field border border-border text-xs text-foreground focus:outline-none focus:border-foreground transition"
                    required={!publishNow}
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-muted mb-1">Timezone</label>
                  <select
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    className="w-full px-2.5 py-1 rounded-md bg-field border border-border text-xs text-foreground focus:outline-none focus:border-foreground transition"
                  >
                    <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
                    <option value="America/New_York">America/New_York (EST)</option>
                    <option value="America/Los_Angeles">America/Los_Angeles (PST)</option>
                    <option value="Europe/London">Europe/London (GMT)</option>
                    <option value="UTC">UTC</option>
                  </select>
                </div>
              </motion.div>
            )}
          </div>

          {/* Progress & Alert Messages */}
          <AnimatePresence>
            {isSubmitting && (
              <div className="p-3 rounded-md bg-surface border border-border space-y-2 text-xs">
                <div className="flex items-center justify-between text-muted">
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-foreground" />
                    <span className="text-foreground font-medium text-[11px]">
                      {submitStage}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono">Zernio REST</span>
                </div>
                <LinearProgress />
              </div>
            )}
          </AnimatePresence>

          {errorMessage && (
            <div className="p-3 rounded-md bg-danger/10 border border-danger/30 text-danger text-xs flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-3.5 h-3.5 text-danger shrink-0" />
                <span>{errorMessage}</span>
              </div>
              <button
                type="button"
                onClick={() => setErrorMessage(null)}
                className="text-danger hover:underline text-xs cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          {responseMessage && (
            <div className="p-3 rounded-md bg-surface border border-border text-foreground text-xs space-y-2">
              <div className="flex items-center justify-between border-b border-border pb-1.5">
                <div className="flex items-center gap-1.5 text-success font-medium">
                  <Check className="w-3.5 h-3.5" />
                  <span>Dispatch Receipt</span>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  icon={copiedResponse ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                  onClick={handleCopyResponse}
                >
                  {copiedResponse ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre className="text-muted text-[11px] whitespace-pre-wrap max-h-24 overflow-y-auto bg-surface-secondary p-2 rounded border border-border font-mono">
                {responseMessage}
              </pre>
            </div>
          )}

          {/* Submit Action Bar */}
          <div className="flex justify-end pt-1">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              isLoading={isSubmitting}
              disabled={isSubmitting || selectedPlatforms.length === 0}
              icon={<Send className="w-3 h-3 fill-current" />}
            >
              {publishNow ? `Dispatch to ${selectedPlatforms.length} Channels` : "Queue for Scheduled Release"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
};
