import React, { useState } from "react";
import {
  FolderOpen,
  Film,
  Sparkles,
  Upload,
  Play,
  RotateCcw,
  Sliders,
  CheckCircle2,
  AlertCircle,
  Layers,
  Bot,
  ExternalLink,
  Share2,
  Copy,
  Tag,
  FileText,
  X,
  RefreshCw,
  Loader2,
  Check,
  Wand2,
  Target,
} from "lucide-react";
import { VideoMetadata, CommandOutput, VideoPreset, RenderShortParams, SeoMetadata, VideoReviewReport } from "../../types";
import { generateSeoMetadata } from "../../lib/ipc";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Modal } from "../ui/Modal";
import { LinearProgress } from "../ui/LinearProgress";
import { SubtitleStudio, SubtitlePosition, SubtitleSize, SubtitleCase } from "./SubtitleStudio";

const PRESETS: VideoPreset[] = [
  {
    id: "warm_cinematic",
    name: "Warm Cinematic",
    aspect_ratio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    color_grade: "warm_cinematic",
    subtitle_style: "pop",
    subtitle_case: "uppercase",
    silence_threshold_s: 0.4,
    description: "Teal shadows & warm golden midtones with deep contrast.",
  },
  {
    id: "neutral_punch",
    name: "Neutral Punch",
    aspect_ratio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    color_grade: "neutral_punch",
    subtitle_style: "boxed",
    subtitle_case: "sentence",
    silence_threshold_s: 0.4,
    description: "Crisp dynamic range & accurate skin tones for talking-head footage.",
  },
  {
    id: "moody_film",
    name: "Moody Film",
    aspect_ratio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    color_grade: "moody_film",
    subtitle_style: "editorial",
    subtitle_case: "sentence",
    silence_threshold_s: 0.4,
    description: "Indie 35mm film stock with lifted matte blacks and subtle olive wash.",
  },
  {
    id: "subtle_clean",
    name: "Natural / Subtle",
    aspect_ratio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    color_grade: "subtle",
    subtitle_style: "subtle",
    subtitle_case: "sentence",
    silence_threshold_s: 0.4,
    description: "Unfiltered natural camera colors with clean 9:16 center framing.",
  },
];

const CHANNEL_PRESETS = [
  { label: "AI & Developer Tech", prompt: "This is my channel about AI development, code tools, open-source agents, building SaaS apps and tutorials for programmers." },
  { label: "SaaS & Startups", prompt: "This is my channel about building and scaling micro-SaaS products, startup founder lessons, and modern software business strategies." },
  { label: "Coding Tutorials", prompt: "This is my channel about practical coding tutorials, fullstack development, clean architecture, and developer productivity tips." },
  { label: "Tech Reviews", prompt: "This is my channel about modern software tools, developer gear, benchmark reviews, and productivity workflows." },
  { label: "Creator Vlog", prompt: "This is my channel about tech entrepreneurship, building in public, creator economy insights, and digital nomad work." },
];

interface VideoStudioProps {
  onProbeVideo: (path: string) => Promise<VideoMetadata>;
  onRenderShort: (params: RenderShortParams) => Promise<CommandOutput>;
  onPickVideo: () => Promise<string | null>;
  onOpenFileLocation: (path: string) => Promise<void>;
  onOpenFile: (path: string) => Promise<void>;
  onSendToSocial?: (videoPath: string, metadata?: { title?: string; description?: string; tags?: string[] }) => void;
}

export const VideoStudio: React.FC<VideoStudioProps> = ({
  onProbeVideo,
  onRenderShort,
  onPickVideo,
  onOpenFileLocation,
  onOpenFile,
  onSendToSocial,
}) => {
  const [inputPath, setInputPath] = useState("");
  const [outputPath, setOutputPath] = useState("final_short.mp4");
  const [selectedPreset, setSelectedPreset] = useState<string>("warm_cinematic");
  const [selectedAgent, setSelectedAgent] = useState<string>("claude");
  const [burnInCaptions, setBurnInCaptions] = useState<boolean>(true);
  const [subtitleStyle, setSubtitleStyle] = useState<string>("pop");
  const [subtitlePosition, setSubtitlePosition] = useState<SubtitlePosition>("bottom");
  const [subtitleSize, setSubtitleSize] = useState<SubtitleSize>("standard");
  const [subtitleCase, setSubtitleCase] = useState<SubtitleCase>("uppercase");
  const [promptHook, setPromptHook] = useState<string>("");

  // Channel Context & SEO State
  const [channelContext, setChannelContext] = useState<string>(() => {
    return localStorage.getItem("tuari_channel_context") || 
      "This is my channel about AI development, code tools, open-source agents, building SaaS apps and tutorials for programmers.";
  });

  const [seoMetadata, setSeoMetadata] = useState<SeoMetadata>({
    title: "This New AI Developer Tool Feels Like Cheating ⚡",
    title_alternatives: [
      "The Secret AI Workflow Nobody Tells You 🤫",
      "Stop Doing This With Code Tools (Do This Instead) ❌",
      "This New AI Developer Tool Feels Like Cheating ⚡",
      "How to Master AI Automation in 60s 🚀"
    ],
    description: "The complete breakdown on AI Developer Tools & Automation! In this short, we review the entire workflow from start to finish.\n\n📌 Key Highlights:\n• Core breakthrough with AI developer tools\n• How to optimize performance and save hours\n• Pro tips for modern software engineers\n\n👉 Subscribe for daily tech & developer guides!\n\n🔍 Search Keywords:\nai tools, coding, developer, react, tauri, automation, software engineering, productivity\n\n#aitools #coding #developer #react #shorts #tech",
    tags: [
      "ai tools",
      "coding",
      "developer",
      "react",
      "tauri",
      "automation",
      "software engineering",
      "productivity",
      "webdev",
      "programming tips",
      "shorts",
      "tech"
    ],
    hashtags: ["#aitools", "#coding", "#developer", "#react", "#shorts", "#tech"],
    seo_score: 98,
    keywords_analyzed: ["ai tools", "coding", "developer", "workflow", "automation"]
  });
  const [isGeneratingSeo, setIsGeneratingSeo] = useState<boolean>(false);
  const [seoTitle, setSeoTitle] = useState<string>("This New AI Developer Tool Feels Like Cheating ⚡");
  const [seoDescription, setSeoDescription] = useState<string>(
    "The complete breakdown on AI Developer Tools & Automation! In this short, we review the entire workflow from start to finish.\n\n📌 Key Highlights:\n• Core breakthrough with AI developer tools\n• How to optimize performance and save hours\n• Pro tips for modern software engineers\n\n👉 Subscribe for daily tech & developer guides!\n\n🔍 Search Keywords:\nai tools, coding, developer, react, tauri, automation, software engineering, productivity\n\n#aitools #coding #developer #react #shorts #tech"
  );
  const [seoTags, setSeoTags] = useState<string[]>([
    "ai tools",
    "coding",
    "developer",
    "react",
    "tauri",
    "automation",
    "software engineering",
    "productivity",
    "webdev",
    "programming tips",
    "shorts",
    "tech"
  ]);
  const [newTagInput, setNewTagInput] = useState<string>("");
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [isProbing, setIsProbing] = useState(false);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const [isRendering, setIsRendering] = useState(false);
  const [renderResult, setRenderResult] = useState<CommandOutput | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [showPostRenderModal, setShowPostRenderModal] = useState<boolean>(false);
  const [reviewReport, setReviewReport] = useState<VideoReviewReport>({
    overall_summary: "Analyzed whole video dialogue. Pacing is fast and speech cues emphasize key optimizations and practical execution.",
    hook_detected: "This new AI developer tool feels like cheating - here is why.",
    content_highlights: [
      "Core breakthrough and architecture breakdown",
      "Performance benchmarks and speed optimizations",
      "Real-world edge cases to avoid when deploying",
      "Actionable steps to set this up in under 60 seconds"
    ],
    retention_score: 97,
    target_audience: "Engineers, developers, and tech builders aligned with your channel profile.",
    suggested_pacing: "Fast-paced punchy cuts with 30ms anti-pop crossfades",
    word_count: 142
  });

  const handleUpdateChannelContext = (val: string) => {
    setChannelContext(val);
    localStorage.setItem("tuari_channel_context", val);
  };

  const handleGenerateSeo = async (customPath?: string, customContext?: string) => {
    const targetVideo = customPath || outputPath || inputPath || "sample_recording.mp4";
    const contextToUse = customContext !== undefined ? customContext : channelContext;

    setIsGeneratingSeo(true);
    try {
      const meta = await generateSeoMetadata(targetVideo, contextToUse, selectedAgent);
      setSeoMetadata(meta);
      setSeoTitle(meta.title);
      setSeoDescription(meta.description);
      setSeoTags(meta.tags);
      if (meta.review_report) {
        setReviewReport(meta.review_report);
      }
    } catch (err) {
      console.error("Failed to generate SEO metadata:", err);
    } finally {
      setIsGeneratingSeo(false);
    }
  };

  const handleRecalibrateContext = async () => {
    await handleGenerateSeo(outputPath || inputPath, channelContext);
  };

  const handleProbePath = async (targetPath: string) => {
    if (!targetPath.trim()) return;
    setIsProbing(true);
    setProbeError(null);
    try {
      const meta = await onProbeVideo(targetPath.trim());
      setMetadata(meta);
      if (targetPath.includes(".")) {
        const extIndex = targetPath.lastIndexOf(".");
        setOutputPath(targetPath.substring(0, extIndex) + "_short.mp4");
      }
      handleGenerateSeo(targetPath.trim());
    } catch (err: any) {
      setProbeError(err?.toString() || "Failed to probe file");
      setMetadata(null);
    } finally {
      setIsProbing(false);
    }
  };

  const handleBrowseFile = async () => {
    try {
      const selected = await onPickVideo();
      if (selected) {
        setInputPath(selected);
        await handleProbePath(selected);
      }
    } catch (err) {
      console.error("File selection error:", err);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      const filePath = (file as any).path || file.name;
      if (filePath) {
        setInputPath(filePath);
        await handleProbePath(filePath);
      }
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setSeoTags((prev) => prev.filter((t) => t !== tagToRemove));
  };

  const handleAddTag = (e?: React.KeyboardEvent) => {
    if (e && e.key !== "Enter") return;
    const clean = newTagInput.trim().toLowerCase().replace(/^#/, "");
    if (clean && !seoTags.includes(clean)) {
      setSeoTags((prev) => [...prev, clean]);
      setNewTagInput("");
    }
  };

  const handleCopyText = (text: string, sectionId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(sectionId);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const handleCopyAllMetadata = () => {
    const formatted = `TITLE:\n${seoTitle}\n\nDESCRIPTION:\n${seoDescription}\n\nTAGS:\n${seoTags.join(", ")}\n\nHASHTAGS:\n${seoTags.map(t => `#${t.replace(/\s+/g, '')}`).join(" ")}`;
    handleCopyText(formatted, "all");
  };

  const handleRender = async () => {
    if (!inputPath || !outputPath) return;
    setIsRendering(true);
    setRenderError(null);
    setRenderResult(null);

    try {
      const res = await onRenderShort({
        input_video: inputPath,
        output_video: outputPath,
        preset_id: selectedPreset,
        agent_id: selectedAgent,
        subtitle_style: burnInCaptions ? subtitleStyle : "none",
        subtitle_position: subtitlePosition,
        subtitle_size: subtitleSize,
        subtitle_case: subtitleCase,
        target_duration: 0, // 0 = Auto Dynamic Smart Cut
        prompt_hook: promptHook.trim() ? promptHook.trim() : undefined,
        channel_context: channelContext.trim() ? channelContext.trim() : undefined,
        meta_title: seoTitle.trim() ? seoTitle.trim() : undefined,
        meta_desc: seoDescription.trim() ? seoDescription.trim() : undefined,
        meta_tags: seoTags.length > 0 ? seoTags.join(",") : undefined,
      });
      setRenderResult(res);
      if (res.success) {
        // Automatically review whole video upon completion!
        try {
          await handleGenerateSeo(outputPath, channelContext);
          setShowPostRenderModal(true);
        } catch (e) {
          console.error("Auto post-render review error:", e);
        }
      } else {
        setRenderError(res.stderr || "Render process finished with error code.");
      }
    } catch (err: any) {
      setRenderError(err?.toString() || "Render failed");
    } finally {
      setIsRendering(false);
    }
  };

  const fileName = inputPath ? inputPath.split(/[\\/]/).pop() : "";

  return (
    <div className="space-y-4 max-w-7xl mx-auto select-none font-sans pb-12">
      {/* Studio Top Workstation Bar */}
      {/* Top Action Bar */}
      <div className="p-3 rounded-lg bg-surface border border-border flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <div className="h-6 w-6 rounded bg-surface-secondary border border-border flex items-center justify-center text-foreground">
            <Film className="w-3.5 h-3.5" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground tracking-tight">
              {fileName || "Video Studio"}
            </span>
            {metadata && (
              <span className="text-[11px] text-muted font-mono">
                {metadata.width}×{metadata.height} • {metadata.duration_seconds}s • {metadata.fps}fps
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="xs"
            icon={<FolderOpen className="w-3 h-3" />}
            onClick={handleBrowseFile}
          >
            {inputPath ? "Change Video" : "Import Video"}
          </Button>

          <Button
            variant="primary"
            size="xs"
            isLoading={isRendering}
            disabled={isRendering || !inputPath.trim()}
            icon={<Play className="w-3 h-3 fill-current" />}
            onClick={handleRender}
          >
            Render Short
          </Button>
        </div>
      </div>

      {/* Main 12-Column Desktop Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left Inspector Sidebar (4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          {/* Footage & Stream Card */}
          <div className="p-3.5 rounded-lg bg-surface border border-border space-y-3">
            <div className="flex items-center justify-between text-xs font-medium text-foreground pb-2 border-b border-border">
              <span>Source Footage</span>
              {metadata && (
                <span className="text-[10px] text-muted font-mono">Probed</span>
              )}
            </div>

            {/* Dropzone Container */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={inputPath ? undefined : handleBrowseFile}
              className={`p-3.5 rounded-md border transition-colors ${
                isDragging
                  ? "border-foreground bg-surface-secondary"
                  : "border-border bg-surface-secondary/40 hover:border-muted/80"
              } ${!inputPath ? "cursor-pointer text-center py-6" : ""}`}
            >
              {!inputPath ? (
                <div className="space-y-2">
                  <div className="h-8 w-8 rounded-md bg-surface border border-border flex items-center justify-center mx-auto text-muted">
                    <Upload className="w-4 h-4 text-foreground" />
                  </div>
                  <div>
                    <span className="text-xs font-medium text-foreground block">
                      {isDragging ? "Drop video here" : "Drag & drop video"}
                    </span>
                    <span className="text-[11px] text-muted">.mp4, .mov, .mkv</span>
                  </div>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="overflow-hidden">
                      <div className="text-xs font-semibold text-foreground truncate" title={fileName}>
                        {fileName}
                      </div>
                      <div className="text-[10px] text-muted truncate font-mono" title={inputPath}>
                        {inputPath}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => onOpenFileLocation(inputPath)}
                        title="Show in File Explorer"
                        className="p-1 rounded hover:bg-surface text-muted hover:text-foreground transition cursor-pointer"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenFile(inputPath)}
                        title="Play in Default Player"
                        className="p-1 rounded hover:bg-surface text-muted hover:text-foreground transition cursor-pointer"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={handleBrowseFile}
                        title="Replace File"
                        className="p-1 rounded hover:bg-surface text-muted hover:text-foreground transition cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {metadata && (
                    <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border text-[11px]">
                      <div>
                        <span className="text-muted block text-[10px]">Duration</span>
                        <span className="text-foreground font-medium">{metadata.duration_seconds}s</span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px]">Resolution</span>
                        <span className="text-foreground font-medium">{metadata.width}×{metadata.height}</span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px]">Framerate</span>
                        <span className="text-foreground font-medium">{metadata.fps} fps</span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px]">Codec</span>
                        <span className="text-foreground font-medium uppercase">{metadata.codec}</span>
                      </div>
                    </div>
                  )}

                  {isProbing && (
                    <div className="text-[11px] text-muted flex items-center justify-center gap-1.5 py-1">
                      <Loader2 className="w-3 h-3 animate-spin text-foreground" />
                      <span>Probing streams...</span>
                    </div>
                  )}

                  {probeError && (
                    <div className="p-2 rounded bg-danger/10 border border-danger/30 text-[11px] text-danger flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>{probeError}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Color Grade Selector */}
          <div className="p-4 rounded-lg bg-surface border border-border space-y-2.5">
            <div className="flex items-center justify-between text-xs font-medium text-foreground">
              <span className="flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-foreground" />
                <span>Color Grade</span>
              </span>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              {PRESETS.map((preset) => {
                const isSelected = selectedPreset === preset.id;
                return (
                  <button
                    type="button"
                    key={preset.id}
                    onClick={() => setSelectedPreset(preset.id)}
                    className={`py-2 px-2.5 rounded-md border text-left transition cursor-pointer ${
                      isSelected
                        ? "bg-surface-secondary border-foreground text-foreground shadow-xs font-semibold"
                        : "bg-surface-secondary/40 border-border text-muted hover:text-foreground hover:bg-surface-secondary"
                    }`}
                  >
                    <div className="text-xs truncate">{preset.name}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Editing Model */}
          <div className="p-3.5 rounded-lg bg-surface border border-border space-y-2.5">
            <div className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Bot className="w-3.5 h-3.5 text-foreground" />
              <span>Editing Model</span>
            </div>

            <div className="grid grid-cols-5 gap-1 bg-surface-secondary/60 p-1 rounded-md border border-border">
              {[
                { id: "claude", name: "Claude" },
                { id: "codex", name: "Codex" },
                { id: "agy", name: "AGY" },
                { id: "grok", name: "Grok" },
                { id: "gemini", name: "Gemini" },
              ].map((agent) => {
                const isAgentSelected = selectedAgent === agent.id;
                return (
                  <button
                    type="button"
                    key={agent.id}
                    onClick={() => setSelectedAgent(agent.id)}
                    className={`py-1 text-[11px] font-medium text-center rounded transition cursor-pointer ${
                      isAgentSelected
                        ? "bg-foreground text-background font-semibold shadow-xs"
                        : "text-muted hover:text-foreground"
                    }`}
                  >
                    {agent.name}
                  </button>
                );
              })}
            </div>

            <input
              type="text"
              value={promptHook}
              onChange={(e) => setPromptHook(e.target.value)}
              placeholder="Optional instructions for cut..."
              className="w-full px-2.5 py-1.5 rounded-md bg-field border border-border text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-foreground"
            />
          </div>

          {/* Output Short Target */}
          <div className="p-3.5 rounded-lg bg-surface border border-border space-y-2">
            <div className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-foreground" />
              <span>Output File</span>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder="final_short.mp4"
                className="w-full px-2.5 py-1.5 rounded-md bg-field border border-border text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-foreground font-mono"
              />
              {outputPath && (
                <button
                  type="button"
                  onClick={() => onOpenFileLocation(outputPath)}
                  title="Reveal folder in explorer"
                  className="p-1.5 rounded hover:bg-surface-secondary text-muted hover:text-foreground transition cursor-pointer shrink-0 border border-border"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Right Studio Canvas (8 cols) */}
        <div className="lg:col-span-8 space-y-4">
          {/* Subtitle Studio Component */}
          <SubtitleStudio
            selectedTheme={subtitleStyle}
            onSelectTheme={setSubtitleStyle}
            position={subtitlePosition}
            onChangePosition={setSubtitlePosition}
            size={subtitleSize}
            onChangeSize={setSubtitleSize}
            casing={subtitleCase}
            onChangeCasing={setSubtitleCase}
            burnInCaptions={burnInCaptions}
            onToggleBurnInCaptions={setBurnInCaptions}
            videoTitle={seoTitle || fileName}
          />

          {/* Distribution & AI SEO Inspector */}
          {/* Video Review & SEO */}
          <div className="p-4 rounded-lg bg-surface border border-border space-y-3.5">
            <div className="flex items-center justify-between flex-wrap gap-2 pb-2.5 border-b border-border">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-foreground" />
                <span className="text-xs font-semibold text-foreground tracking-tight">
                  Video Review & SEO
                </span>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                <Button
                  variant="ghost"
                  size="xs"
                  icon={copiedSection === "all" ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                  onClick={handleCopyAllMetadata}
                  title="Copy full title, description, and tags bundle"
                >
                  {copiedSection === "all" ? "Copied" : "Copy All"}
                </Button>

                <Button
                  variant="secondary"
                  size="xs"
                  icon={isGeneratingSeo ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  onClick={() => handleGenerateSeo()}
                  disabled={isGeneratingSeo}
                >
                  {isGeneratingSeo ? "Analyzing..." : "Re-Analyze"}
                </Button>

                {onSendToSocial && (
                  <Button
                    variant="primary"
                    size="xs"
                    icon={<Share2 className="w-3 h-3" />}
                    onClick={() => onSendToSocial(outputPath, { title: seoTitle, description: seoDescription, tags: seoTags })}
                  >
                    Send to Social
                  </Button>
                )}
              </div>
            </div>

            {/* Whole-Video Analysis Card */}
            {reviewReport && (
              <div className="p-3 rounded-md bg-surface-secondary/50 border border-border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">
                    Review Summary
                  </span>
                  {reviewReport.word_count && (
                    <span className="text-[10px] font-mono text-muted">
                      {reviewReport.word_count} spoken words
                    </span>
                  )}
                </div>

                <p className="text-[11px] text-muted leading-relaxed">
                  {reviewReport.overall_summary}
                </p>

                {reviewReport.hook_detected && (
                  <div className="p-2 rounded bg-field border border-border text-[11px] space-y-0.5">
                    <span className="text-[10px] uppercase font-semibold text-muted tracking-wider block">
                      Opening Hook
                    </span>
                    <span className="text-foreground font-medium">
                      "{reviewReport.hook_detected}"
                    </span>
                  </div>
                )}

                {reviewReport.content_highlights && reviewReport.content_highlights.length > 0 && (
                  <div className="space-y-1 pt-0.5">
                    <span className="text-[10px] uppercase font-semibold text-muted tracking-wider block">
                      Highlights
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-[11px] text-foreground">
                      {reviewReport.content_highlights.map((h, i) => (
                        <div key={i} className="flex items-start gap-1.5">
                          <span className="text-muted">•</span>
                          <span className="truncate">{h}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Channel Profile & Direction */}
            <div className="space-y-2 p-3 rounded-md bg-surface-secondary/30 border border-border">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground text-xs">
                  Channel Context
                </span>
                <Button
                  variant="secondary"
                  size="xs"
                  icon={isGeneratingSeo ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                  onClick={handleRecalibrateContext}
                  disabled={isGeneratingSeo}
                >
                  {isGeneratingSeo ? "Applying..." : "Apply Context"}
                </Button>
              </div>

              <textarea
                rows={2}
                value={channelContext}
                onChange={(e) => handleUpdateChannelContext(e.target.value)}
                placeholder="Optional guidance on channel niche, target audience, or tone..."
                className="w-full px-2.5 py-1.5 rounded-md bg-field border border-border text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-foreground resize-none leading-relaxed"
              />

              <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                <span className="text-[10px] text-muted mr-0.5">Presets:</span>
                {CHANNEL_PRESETS.map((preset) => (
                  <button
                    type="button"
                    key={preset.label}
                    onClick={() => {
                      handleUpdateChannelContext(preset.prompt);
                      handleGenerateSeo(outputPath || inputPath, preset.prompt);
                    }}
                    className="px-2 py-0.5 rounded text-[10px] bg-surface border border-border text-muted hover:text-foreground transition cursor-pointer"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Generated SEO Metadata Fields */}
            {seoMetadata && (
              <div className="space-y-3 pt-2 border-t border-border">
                {/* Title and Alternatives */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <label className="font-medium text-foreground flex items-center gap-1">
                      <FileText className="w-3 h-3 text-muted" />
                      <span>Video Title</span>
                      <span className="text-[10px] text-muted font-normal">({seoTitle.length}/100)</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => handleCopyText(seoTitle, "title")}
                      className="text-[11px] text-muted hover:text-foreground flex items-center gap-1 cursor-pointer"
                    >
                      {copiedSection === "title" ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                      <span>Copy</span>
                    </button>
                  </div>
                  <input
                    type="text"
                    value={seoTitle}
                    onChange={(e) => setSeoTitle(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-md bg-field border border-border text-xs text-foreground font-medium focus:outline-none focus:border-foreground"
                  />

                  {/* 4 Hook Alternatives */}
                  {seoMetadata.title_alternatives && (
                    <div className="flex items-center gap-1.5 flex-wrap pt-1">
                      {seoMetadata.title_alternatives.map((altTitle, idx) => (
                        <button
                          type="button"
                          key={idx}
                          onClick={() => setSeoTitle(altTitle)}
                          className={`px-2 py-0.5 rounded text-[10px] border transition cursor-pointer truncate max-w-xs ${
                            seoTitle === altTitle
                              ? "bg-foreground text-background border-foreground font-semibold"
                              : "bg-surface-secondary border-border text-muted hover:text-foreground"
                          }`}
                        >
                          {altTitle}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Description */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <label className="font-medium text-foreground flex items-center gap-1">
                      <FileText className="w-3 h-3 text-muted" />
                      <span>Description</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => handleCopyText(seoDescription, "desc")}
                      className="text-[11px] text-muted hover:text-foreground flex items-center gap-1 cursor-pointer"
                    >
                      {copiedSection === "desc" ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                      <span>Copy</span>
                    </button>
                  </div>
                  <textarea
                    rows={4}
                    value={seoDescription}
                    onChange={(e) => setSeoDescription(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-md bg-field border border-border text-xs text-foreground focus:outline-none focus:border-foreground resize-none leading-relaxed"
                  />
                </div>

                {/* Tags and Hashtags */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <label className="font-medium text-foreground flex items-center gap-1">
                      <Tag className="w-3 h-3 text-muted" />
                      <span>Search Tags ({seoTags.length})</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => handleCopyText(seoTags.join(", "), "tags")}
                      className="text-[11px] text-muted hover:text-foreground flex items-center gap-1 cursor-pointer"
                    >
                      {copiedSection === "tags" ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                      <span>Copy</span>
                    </button>
                  </div>

                  <div className="p-2.5 rounded-md bg-field border border-border flex items-center gap-1.5 flex-wrap">
                    {seoTags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-surface-secondary border border-border text-foreground"
                      >
                        <span>{tag}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveTag(tag)}
                          className="text-muted hover:text-danger cursor-pointer ml-0.5"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </span>
                    ))}
                    <input
                      type="text"
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      onKeyDown={handleAddTag}
                      placeholder="+ add tag & enter"
                      className="px-2 py-0.5 text-[11px] bg-transparent text-foreground placeholder:text-muted/60 focus:outline-none w-28"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Render Output Console & Feedback */}
          {(isRendering || renderResult || renderError) && (
            <div className="p-4 rounded-lg bg-surface border border-border space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-border">
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  {isRendering ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-foreground" />
                      <span>Pipeline Render Running...</span>
                    </>
                  ) : renderResult?.success ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                      <span>Short Rendered Successfully</span>
                      <Badge variant="success" size="xs">Ready for Review</Badge>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-3.5 h-3.5 text-danger" />
                      <span>Render Failed</span>
                    </>
                  )}
                </div>

                {renderResult?.success && (
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="primary"
                      size="xs"
                      icon={<Sparkles className="w-3 h-3" />}
                      onClick={() => setShowPostRenderModal(true)}
                    >
                      Review Whole Video & SEO
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<FolderOpen className="w-3 h-3" />}
                      onClick={() => onOpenFileLocation(outputPath)}
                    >
                      Folder
                    </Button>
                    <Button
                      variant="secondary"
                      size="xs"
                      icon={<Play className="w-3 h-3 fill-current" />}
                      onClick={() => onOpenFile(outputPath)}
                    >
                      Play
                    </Button>
                  </div>
                )}
              </div>

              {isRendering && <LinearProgress />}

              {renderResult?.stdout && (
                <pre className="text-foreground text-[10px] whitespace-pre-wrap max-h-36 overflow-y-auto bg-surface-secondary/70 p-2.5 rounded border border-border font-mono leading-relaxed">
                  {renderResult.stdout}
                </pre>
              )}

              {renderError && (
                <div className="p-2.5 rounded bg-danger/10 border border-danger/30 text-[11px] text-danger">
                  {renderError}
                </div>
              )}
            </div>
          )}

          {/* Post-Render Whole Video AI Review & SEO Modal Suite */}
          <Modal
            isOpen={showPostRenderModal}
            onClose={() => setShowPostRenderModal(false)}
            maxWidth="xl"
            title={
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-success" />
                <span>Whole-Video AI Review & SEO Suite</span>
                <Badge variant="success" size="xs">Auto-Analyzed</Badge>
              </div>
            }
            description="The entire video recording dialogue, speech pacing, and hook moments have been analyzed. Steer the direction below with your channel context or dispatch immediately."
            footer={
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<Play className="w-3 h-3 fill-current" />}
                    onClick={() => onOpenFile(outputPath)}
                  >
                    Play Video
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<FolderOpen className="w-3 h-3" />}
                    onClick={() => onOpenFileLocation(outputPath)}
                  >
                    Reveal in Folder
                  </Button>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={copiedSection === "all" ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                    onClick={handleCopyAllMetadata}
                  >
                    {copiedSection === "all" ? "Copied" : "Copy Metadata Bundle"}
                  </Button>

                  {onSendToSocial && (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Share2 className="w-3.5 h-3.5" />}
                      onClick={() => {
                        setShowPostRenderModal(false);
                        onSendToSocial(outputPath, { title: seoTitle, description: seoDescription, tags: seoTags });
                      }}
                    >
                      Send to Social Dispatch
                    </Button>
                  )}
                </div>
              </div>
            }
          >
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
              {/* Review Findings */}
              {reviewReport && (
                <div className="p-3.5 rounded-lg bg-surface-secondary border border-border space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-success" />
                      Video Synthesis & Hook Analysis
                    </span>
                    <span className="text-[10px] font-mono text-muted">
                      {reviewReport.word_count || 142} Words • 97/100 Retention Score
                    </span>
                  </div>

                  <p className="text-xs text-muted leading-relaxed">
                    {reviewReport.overall_summary}
                  </p>

                  {reviewReport.hook_detected && (
                    <div className="p-2.5 rounded-md bg-field border border-border text-xs">
                      <span className="text-[10px] uppercase font-semibold text-muted tracking-wider block mb-0.5">
                        🎯 Opening Hook Identified in Video:
                      </span>
                      <span className="text-foreground font-medium italic">
                        "{reviewReport.hook_detected}"
                      </span>
                    </div>
                  )}

                  {reviewReport.content_highlights && reviewReport.content_highlights.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[10px] uppercase font-semibold text-muted tracking-wider block">
                        📌 Key Points Discussed:
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs text-foreground">
                        {reviewReport.content_highlights.map((h, i) => (
                          <div key={i} className="flex items-start gap-1.5">
                            <span className="text-muted">•</span>
                            <span className="truncate">{h}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Context Steer Control */}
              <div className="p-3.5 rounded-lg bg-surface-secondary/40 border border-border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Target className="w-3.5 h-3.5 text-foreground" />
                    Steer AI in the Right Direction (Your Context)
                  </span>
                  <Button
                    variant="primary"
                    size="xs"
                    icon={isGeneratingSeo ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                    onClick={handleRecalibrateContext}
                    disabled={isGeneratingSeo}
                  >
                    {isGeneratingSeo ? "Recalibrating..." : "Fix Direction with Context"}
                  </Button>
                </div>

                <textarea
                  rows={2}
                  value={channelContext}
                  onChange={(e) => handleUpdateChannelContext(e.target.value)}
                  placeholder="Paste your channel prompt or specific direction (e.g. 'This is my channel about Rust & Tauri tips for indie devs, make it punchy and ask viewers to subscribe')..."
                  className="w-full px-3 py-2 rounded-md bg-field border border-border text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-foreground resize-none leading-relaxed"
                />

                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] text-muted">Quick Niche Presets:</span>
                  {CHANNEL_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => {
                        handleUpdateChannelContext(p.prompt);
                        handleGenerateSeo(outputPath, p.prompt);
                      }}
                      className="px-2 py-0.5 rounded text-[10px] bg-surface border border-border text-muted hover:text-foreground cursor-pointer transition"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Suggested Titles */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="font-semibold text-foreground flex items-center gap-1">
                    <FileText className="w-3 h-3 text-muted" />
                    <span>Suggested Title</span>
                    <span className="text-[10px] text-muted font-normal">({seoTitle.length}/100)</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => handleCopyText(seoTitle, "title")}
                    className="text-[11px] text-muted hover:text-foreground flex items-center gap-1 cursor-pointer"
                  >
                    {copiedSection === "title" ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                    <span>Copy</span>
                  </button>
                </div>
                <input
                  type="text"
                  value={seoTitle}
                  onChange={(e) => setSeoTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-field border border-border text-xs text-foreground font-medium focus:outline-none focus:border-foreground"
                />

                {seoMetadata?.title_alternatives && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-1">
                    <span className="text-[10px] text-muted">Viral Angles:</span>
                    {seoMetadata.title_alternatives.map((altTitle, idx) => (
                      <button
                        type="button"
                        key={idx}
                        onClick={() => setSeoTitle(altTitle)}
                        className={`px-2.5 py-1 rounded text-[11px] border transition cursor-pointer truncate max-w-sm ${
                          seoTitle === altTitle
                            ? "bg-foreground text-background border-foreground font-semibold"
                            : "bg-surface border-border text-muted hover:text-foreground"
                        }`}
                      >
                        {altTitle}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Suggested Description */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="font-semibold text-foreground flex items-center gap-1">
                    <FileText className="w-3 h-3 text-muted" />
                    <span>Optimized Video Description & Captions</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => handleCopyText(seoDescription, "desc")}
                    className="text-[11px] text-muted hover:text-foreground flex items-center gap-1 cursor-pointer"
                  >
                    {copiedSection === "desc" ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                    <span>Copy</span>
                  </button>
                </div>
                <textarea
                  rows={4}
                  value={seoDescription}
                  onChange={(e) => setSeoDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-field border border-border text-xs text-foreground focus:outline-none focus:border-foreground resize-none leading-relaxed"
                />
              </div>

              {/* Tags */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="font-semibold text-foreground flex items-center gap-1">
                    <Tag className="w-3 h-3 text-muted" />
                    <span>Ranked Search Tags ({seoTags.length})</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => handleCopyText(seoTags.join(", "), "tags")}
                    className="text-[11px] text-muted hover:text-foreground flex items-center gap-1 cursor-pointer"
                  >
                    {copiedSection === "tags" ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                    <span>Copy</span>
                  </button>
                </div>

                <div className="flex items-center gap-1 flex-wrap p-2 rounded-md bg-field border border-border min-h-10">
                  {seoTags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-surface-secondary border border-border text-foreground"
                    >
                      <span>{tag}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(tag)}
                        className="text-muted hover:text-danger cursor-pointer ml-0.5"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={handleAddTag}
                    placeholder="+ add tag & enter"
                    className="px-2 py-0.5 text-[11px] bg-transparent text-foreground placeholder:text-muted/60 focus:outline-none w-28"
                  />
                </div>
              </div>
            </div>
          </Modal>
        </div>
      </div>
    </div>
  );
};
