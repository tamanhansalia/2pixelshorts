import React, { useState, useEffect } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  Check,
  Type,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  Sliders,
} from "lucide-react";

export type SubtitlePosition = "top" | "center" | "bottom";
export type SubtitleSize = "compact" | "standard" | "large";
export type SubtitleCase = "uppercase" | "title" | "sentence";

export interface SubtitleThemeDefinition {
  id: string;
  name: string;
  tag: string;
  category: "viral" | "pill" | "neon" | "cinematic";
  colors: string[];
  description: string;
  sampleWords: [string, string, string]; // [prev, active, next]
}

export const SUBTITLE_THEMES: SubtitleThemeDefinition[] = [
  {
    id: "pop",
    name: "Pop",
    tag: "Viral Punch",
    category: "viral",
    colors: ["#FFE500", "#FFFFFF", "#000000"],
    description: "High-impact bold yellow punch with heavy 3D shadow",
    sampleWords: ["THIS", "TOOL", "ROCKS"],
  },
  {
    id: "spotlight",
    name: "Spotlight",
    tag: "Purple Pill",
    category: "pill",
    colors: ["#7C3AED", "#FFFFFF"],
    description: "Modern sans-serif with active word in purple capsule",
    sampleWords: ["Create", "Viral", "Shorts"],
  },
  {
    id: "impact",
    name: "Impact",
    tag: "Heavy Yellow",
    category: "viral",
    colors: ["#FACC15", "#FFFFFF", "#000000"],
    description: "Ultra-condensed heavy typography with pitch black outline",
    sampleWords: ["MASSIVE", "RESULTS", "TODAY"],
  },
  {
    id: "glow",
    name: "Glow",
    tag: "Cyan Electric",
    category: "neon",
    colors: ["#00F5FF", "#FFFFFF"],
    description: "Cyberpunk cyan electric aura with diffuse neon glow",
    sampleWords: ["FUTURE", "TECH", "CODING"],
  },
  {
    id: "boxed",
    name: "Boxed",
    tag: "Dark Backing",
    category: "pill",
    colors: ["#FACC15", "#FFFFFF", "#18181B"],
    description: "Frosted obsidian backing box with vibrant yellow active word",
    sampleWords: ["CLEAN", "MINIMAL", "SETUP"],
  },
  {
    id: "sweep",
    name: "Sweep",
    tag: "Pink Karaoke",
    category: "neon",
    colors: ["#EC4899", "#FFFFFF"],
    description: "Dynamic karaoke style with hot magenta word sweep",
    sampleWords: ["Dynamic", "Flowing", "Karaoke"],
  },
  {
    id: "editorial",
    name: "Editorial",
    tag: "Documentary",
    category: "cinematic",
    colors: ["#EAB308", "#ECECE8"],
    description: "Sophisticated Georgia serif italic with warm gold highlight",
    sampleWords: ["The", "Hidden", "Secret"],
  },
  {
    id: "hype",
    name: "Hype",
    tag: "Toxic Green",
    category: "viral",
    colors: ["#22C55E", "#FFFFFF"],
    description: "High-tempo energy with neon toxic green accent",
    sampleWords: ["HYPER", "FAST", "GROWTH"],
  },
  {
    id: "punch",
    name: "Punch",
    tag: "Single Word",
    category: "viral",
    colors: ["#FFFFFF", "#000000"],
    description: "Massive isolated single-word punch for ultra-fast retention",
    sampleWords: ["", "INSANE", ""],
  },
  {
    id: "neon",
    name: "Neon",
    tag: "Violet Tube",
    category: "neon",
    colors: ["#F43F5E", "#A855F7"],
    description: "Vaporwave tube glow with magenta-violet gradient aura",
    sampleWords: ["NIGHT", "CITY", "PULSE"],
  },
  {
    id: "headline",
    name: "Headline",
    tag: "News Badge",
    category: "pill",
    colors: ["#EF4444", "#FFFFFF"],
    description: "Breaking news urgency with bold crimson capsule",
    sampleWords: ["BREAKING", "UPDATE", "ALERT"],
  },
  {
    id: "paper",
    name: "Paper",
    tag: "Light Pill",
    category: "pill",
    colors: ["#7C3AED", "#18181B", "#FFFFFF"],
    description: "Ultra-clean white pill container with dark typography & purple accent",
    sampleWords: ["Modern", "Studio", "Design"],
  },
  {
    id: "subtle",
    name: "Subtle",
    tag: "Minimalist",
    category: "cinematic",
    colors: ["#FBBF24", "#D4D4D8"],
    description: "Restrained sentence-case with gentle warm amber active word",
    sampleWords: ["simple", "natural", "clarity"],
  },
];

interface SubtitleStudioProps {
  selectedTheme: string;
  onSelectTheme: (themeId: string) => void;
  position: SubtitlePosition;
  onChangePosition: (pos: SubtitlePosition) => void;
  size: SubtitleSize;
  onChangeSize: (size: SubtitleSize) => void;
  casing: SubtitleCase;
  onChangeCasing: (casing: SubtitleCase) => void;
  burnInCaptions: boolean;
  onToggleBurnInCaptions: (val: boolean) => void;
  videoTitle?: string;
}

export const SubtitleStudio: React.FC<SubtitleStudioProps> = ({
  selectedTheme,
  onSelectTheme,
  position,
  onChangePosition,
  size,
  onChangeSize,
  casing,
  onChangeCasing,
  burnInCaptions,
  onToggleBurnInCaptions,
  videoTitle,
}) => {
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [customText, setCustomText] = useState<string>(
    "THIS NEW AI TOOL CHANGES EVERYTHING"
  );
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [activeWordIndex, setActiveWordIndex] = useState<number>(0);
  const [showGuides, setShowGuides] = useState<boolean>(false);

  // Split custom phrase into words
  const words = React.useMemo(() => {
    const raw = customText.trim() ? customText.trim().split(/\s+/) : ["AI", "CREATES", "MAGIC"];
    return raw.map((w, idx) => {
      if (casing === "uppercase") return w.toUpperCase();
      if (casing === "title") return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      if (casing === "sentence") return idx === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase();
      return w;
    });
  }, [customText, casing]);

  // Real-time animation ticker
  useEffect(() => {
    if (!isPlaying || words.length === 0) return;
    const interval = setInterval(() => {
      setActiveWordIndex((prev) => (prev + 1) % words.length);
    }, 450);
    return () => clearInterval(interval);
  }, [isPlaying, words.length]);

  // Filtered themes
  const filteredThemes = React.useMemo(() => {
    if (activeCategory === "all") return SUBTITLE_THEMES;
    return SUBTITLE_THEMES.filter((t) => t.category === activeCategory);
  }, [activeCategory]);

  // Size class calculation
  const getSizeClasses = () => {
    switch (size) {
      case "compact":
        return "text-xs tracking-tight";
      case "large":
        return "text-base tracking-wide";
      case "standard":
      default:
        return "text-sm tracking-normal";
    }
  };

  // Position class calculation for 9:16 monitor canvas
  const getPositionClasses = () => {
    switch (position) {
      case "top":
        return "top-10";
      case "center":
        return "top-1/2 -translate-y-1/2";
      case "bottom":
      default:
        return "bottom-14";
    }
  };

  // Helper to render active word styling based on theme
  const renderThemeText = (themeId: string, word: string, isActive: boolean) => {
    switch (themeId) {
      case "pop":
        return (
          <span
            className={`font-black uppercase inline-block transition-transform duration-150 ${
              isActive
                ? "text-[#FFE500] scale-110"
                : "text-white"
            }`}
            style={{
              textShadow:
                "2px 2px 0 #000, -1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 0 3px 6px rgba(0,0,0,0.9)",
            }}
          >
            {word}
          </span>
        );

      case "spotlight":
        return isActive ? (
          <span className="bg-[#7C3AED] text-white px-2 py-0.5 rounded-full font-bold shadow-md shadow-purple-900/50 inline-block scale-105 transition-all">
            {word}
          </span>
        ) : (
          <span
            className="text-white font-bold inline-block"
            style={{ textShadow: "0 2px 4px rgba(0,0,0,0.9)" }}
          >
            {word}
          </span>
        );

      case "impact":
        return (
          <span
            className={`font-black uppercase tracking-tight inline-block transition-all ${
              isActive ? "text-[#FACC15] scale-105" : "text-white"
            }`}
            style={{
              textShadow:
                "2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000",
            }}
          >
            {word}
          </span>
        );

      case "glow":
        return (
          <span
            className={`font-extrabold uppercase tracking-wide inline-block transition-all ${
              isActive
                ? "text-[#00F5FF]"
                : "text-white/90"
            }`}
            style={
              isActive
                ? {
                    textShadow:
                      "0 0 10px #00F5FF, 0 0 20px rgba(0, 245, 255, 0.7), 1px 1px 2px #000",
                  }
                : { textShadow: "0 2px 4px rgba(0,0,0,0.8)" }
            }
          >
            {word}
          </span>
        );

      case "boxed":
        return (
          <span
            className={`font-bold tracking-tight inline-block ${
              isActive ? "text-[#FACC15]" : "text-neutral-100"
            }`}
          >
            {word}
          </span>
        );

      case "sweep":
        return (
          <span
            className={`font-extrabold tracking-tight inline-block transition-all ${
              isActive
                ? "text-[#EC4899] scale-105"
                : "text-white"
            }`}
            style={
              isActive
                ? {
                    textShadow:
                      "0 0 12px rgba(236,72,153,0.8), 1px 1px 2px #000",
                  }
                : { textShadow: "0 2px 4px rgba(0,0,0,0.8)" }
            }
          >
            {word}
          </span>
        );

      case "editorial":
        return (
          <span
            className={`font-serif italic tracking-wide inline-block ${
              isActive
                ? "text-[#EAB308] underline underline-offset-4 decoration-2"
                : "text-[#ECECE8]"
            }`}
            style={{ textShadow: "0 2px 4px rgba(0,0,0,0.9)" }}
          >
            {word}
          </span>
        );

      case "hype":
        return (
          <span
            className={`font-black uppercase tracking-tight inline-block transition-all ${
              isActive
                ? "text-[#22C55E] scale-110"
                : "text-white"
            }`}
            style={
              isActive
                ? {
                    textShadow:
                      "0 0 12px rgba(34,197,94,0.9), 2px 2px 0 #000",
                  }
                : { textShadow: "2px 2px 0 #000, -1px -1px 0 #000" }
            }
          >
            {word}
          </span>
        );

      case "punch":
        return (
          <span
            className="font-black uppercase tracking-wider text-white inline-block scale-110"
            style={{
              textShadow:
                "2.5px 2.5px 0 #000, -1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000",
            }}
          >
            {word}
          </span>
        );

      case "neon":
        return (
          <span
            className={`font-extrabold uppercase tracking-wide inline-block ${
              isActive
                ? "text-[#F43F5E]"
                : "text-white/80"
            }`}
            style={
              isActive
                ? {
                    textShadow:
                      "0 0 12px #F43F5E, 0 0 24px #A855F7, 1px 1px 2px #000",
                  }
                : { textShadow: "0 2px 4px rgba(0,0,0,0.8)" }
            }
          >
            {word}
          </span>
        );

      case "headline":
        return isActive ? (
          <span className="bg-[#EF4444] text-white px-1.5 py-0.5 rounded font-black tracking-tight shadow-md inline-block">
            {word}
          </span>
        ) : (
          <span
            className="font-black tracking-tight text-white inline-block"
            style={{ textShadow: "2px 2px 0 #000" }}
          >
            {word}
          </span>
        );

      case "paper":
        return (
          <span
            className={`font-bold tracking-tight inline-block ${
              isActive
                ? "text-[#7C3AED] font-black"
                : "text-neutral-900"
            }`}
          >
            {word}
          </span>
        );

      case "subtle":
        return (
          <span
            className={`font-medium tracking-normal inline-block ${
              isActive
                ? "text-[#FBBF24] font-semibold"
                : "text-neutral-300"
            }`}
          >
            {word}
          </span>
        );

      default:
        return <span>{word}</span>;
    }
  };

  // Wrapper for boxed / paper / subtle pill backgrounds
  const renderSubtitleContainer = (themeId: string, children: React.ReactNode) => {
    if (themeId === "boxed") {
      return (
        <div className="bg-black/85 backdrop-blur-md px-3.5 py-1.5 rounded-xl border border-white/10 shadow-2xl inline-flex items-center gap-1.5 flex-wrap justify-center">
          {children}
        </div>
      );
    }
    if (themeId === "paper") {
      return (
        <div className="bg-white/95 px-3 py-1 rounded-full shadow-xl border border-neutral-200 inline-flex items-center gap-1.5 flex-wrap justify-center">
          {children}
        </div>
      );
    }
    if (themeId === "subtle") {
      return (
        <div className="bg-black/60 px-3 py-1 rounded-lg backdrop-blur-xs border border-white/5 inline-flex items-center gap-1.5 flex-wrap justify-center">
          {children}
        </div>
      );
    }
    return (
      <div className="inline-flex items-center gap-1.5 flex-wrap justify-center px-2">
        {children}
      </div>
    );
  };

  return (
    <div className="p-4 rounded-lg bg-surface border border-border space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-foreground tracking-tight">
            Subtitles & Captions
          </h2>
        </div>

        {/* Burn in captions switch */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Burn in captions</span>
          <button
            type="button"
            role="switch"
            aria-checked={burnInCaptions}
            onClick={() => onToggleBurnInCaptions(!burnInCaptions)}
            className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-150 ease-in-out focus:outline-none ${
              burnInCaptions ? "bg-foreground" : "bg-surface-secondary border-border"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-background shadow-xs transition duration-150 ease-in-out mt-0.5 ${
                burnInCaptions ? "translate-x-3.5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </div>

      {burnInCaptions ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Professional 9:16 Video Monitor (5 cols) */}
          <div className="lg:col-span-5 flex flex-col items-center">
            {/* Professional Video Viewport Container */}
            <div className="w-full max-w-[300px] rounded-lg bg-surface border border-border overflow-hidden shadow-xs flex flex-col">
              {/* Monitor Top Control / Header Bar */}
              <div className="h-7 bg-surface-secondary border-b border-border px-3 flex items-center justify-between text-[11px] select-none">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span className="font-mono text-[10px] font-semibold text-foreground tracking-wide uppercase">
                    Monitor • 9:16
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-muted">
                  <span>1080×1920</span>
                  <span className="text-border">•</span>
                  <span>{isPlaying ? "00:04.18" : "PAUSED"}</span>
                </div>
              </div>

              {/* Viewport Screen */}
              <div className="relative w-full aspect-[9/16] bg-neutral-950 overflow-hidden flex flex-col justify-between select-none">
                {/* Subtle Studio Backdrop with Clean Dark Neutral Tone */}
                <div className="absolute inset-0 bg-neutral-950">
                  <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_35%,rgba(255,255,255,0.05),transparent)]" />
                  <div className="absolute bottom-0 inset-x-0 h-32 bg-gradient-to-t from-black/80 to-transparent" />
                </div>

                {/* Optional Subtle Safe-Zone Guides Overlay (clean, technical) */}
                {showGuides && (
                  <div className="absolute inset-3 pointer-events-none z-10 border border-white/10 rounded-sm flex flex-col justify-between">
                    <div className="border-b border-dashed border-white/15 p-1 text-[8px] font-mono text-white/30 uppercase tracking-wider">
                      Top Safe Margin
                    </div>
                    <div className="border-t border-dashed border-white/15 p-1 text-[8px] font-mono text-white/30 uppercase tracking-wider text-right">
                      Action Safe Area
                    </div>
                  </div>
                )}

                {/* Top Clip Info Banner */}
                <div className="relative z-20 pt-2.5 px-3 flex items-center justify-between text-[10px] text-white/70">
                  <span className="font-mono text-[9px] bg-black/60 px-2 py-0.5 rounded border border-white/10 truncate max-w-[180px]">
                    {videoTitle || "Active Sequence"}
                  </span>
                  <span className="font-mono text-[9px] text-white/40">
                    {activeWordIndex + 1}/{words.length}
                  </span>
                </div>

                {/* Animated Subtitle Zone */}
                <div
                  className={`absolute inset-x-3 text-center z-20 transition-all duration-200 pointer-events-none ${getPositionClasses()} ${getSizeClasses()}`}
                >
                  {renderSubtitleContainer(
                    selectedTheme,
                    selectedTheme === "punch" ? (
                      renderThemeText(
                        selectedTheme,
                        words[activeWordIndex] || "INSANE",
                        true
                      )
                    ) : (
                      words.map((word, idx) => (
                        <React.Fragment key={idx}>
                          {renderThemeText(
                            selectedTheme,
                            word,
                            idx === activeWordIndex
                          )}
                        </React.Fragment>
                      ))
                    )
                  )}
                </div>

                {/* Bottom Video Progress Scrub Bar */}
                <div className="relative z-20 w-full bg-white/10 h-1">
                  <div
                    className="bg-white/80 h-full transition-all duration-200"
                    style={{
                      width: `${((activeWordIndex + 1) / Math.max(1, words.length)) * 100}%`,
                    }}
                  />
                </div>
              </div>

              {/* Monitor Bottom Control Strip */}
              <div className="h-9 px-3 bg-surface-secondary border-t border-border flex items-center justify-between text-xs">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setIsPlaying(!isPlaying)}
                    className="p-1.5 rounded hover:bg-surface text-muted hover:text-foreground transition cursor-pointer"
                    title={isPlaying ? "Pause Preview Animation" : "Play Preview Animation"}
                  >
                    {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveWordIndex(0)}
                    className="p-1.5 rounded hover:bg-surface text-muted hover:text-foreground transition cursor-pointer"
                    title="Restart Animation Loop"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setShowGuides(!showGuides)}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono transition cursor-pointer border ${
                    showGuides
                      ? "bg-surface text-foreground border-border shadow-xs"
                      : "text-muted hover:text-foreground border-transparent"
                  }`}
                  title="Toggle Title Safe Guides"
                >
                  Guides
                </button>
              </div>
            </div>
          </div>

          {/* Right Column: Theme Carousel & Controls (7 cols) */}
          <div className="lg:col-span-7 space-y-5">
            {/* Position, Size & Casing Controls Toolbar */}
            <div className="p-3.5 rounded-lg bg-surface-secondary/50 border border-border space-y-3">
              <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-foreground" />
                <span>Typography</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Position Segmented Control */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-muted block">
                    Vertical Position
                  </label>
                  <div className="grid grid-cols-3 gap-1 bg-surface p-1 rounded-lg border border-border">
                    {[
                      { id: "top" as SubtitlePosition, label: "Top", icon: AlignVerticalJustifyStart },
                      { id: "center" as SubtitlePosition, label: "Center", icon: AlignVerticalJustifyCenter },
                      { id: "bottom" as SubtitlePosition, label: "Bottom", icon: AlignVerticalJustifyEnd },
                    ].map((pos) => {
                      const isSelected = position === pos.id;
                      const Icon = pos.icon;
                      return (
                        <button
                          type="button"
                          key={pos.id}
                          onClick={() => onChangePosition(pos.id)}
                          className={`py-1.5 px-2 rounded-md text-[11px] font-medium flex items-center justify-center gap-1 transition cursor-pointer ${
                            isSelected
                              ? "bg-foreground text-background shadow-xs font-semibold"
                              : "text-muted hover:text-foreground"
                          }`}
                        >
                          <Icon className="w-3 h-3" />
                          <span>{pos.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Size Segmented Control */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-muted block">
                    Font Size
                  </label>
                  <div className="grid grid-cols-3 gap-1 bg-surface p-1 rounded-lg border border-border">
                    {[
                      { id: "compact" as SubtitleSize, label: "85%" },
                      { id: "standard" as SubtitleSize, label: "100%" },
                      { id: "large" as SubtitleSize, label: "120%" },
                    ].map((s) => {
                      const isSelected = size === s.id;
                      return (
                        <button
                          type="button"
                          key={s.id}
                          onClick={() => onChangeSize(s.id)}
                          className={`py-1.5 px-2 rounded-md text-[11px] font-medium text-center transition cursor-pointer ${
                            isSelected
                              ? "bg-foreground text-background shadow-xs font-semibold"
                              : "text-muted hover:text-foreground"
                          }`}
                        >
                          {s.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Casing Segmented Control */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-muted block">
                    Text Casing
                  </label>
                  <div className="grid grid-cols-3 gap-1 bg-surface p-1 rounded-lg border border-border">
                    {[
                      { id: "uppercase" as SubtitleCase, label: "ABC" },
                      { id: "title" as SubtitleCase, label: "Abc" },
                      { id: "sentence" as SubtitleCase, label: "abc" },
                    ].map((c) => {
                      const isSelected = casing === c.id;
                      return (
                        <button
                          type="button"
                          key={c.id}
                          onClick={() => onChangeCasing(c.id)}
                          className={`py-1.5 px-2 rounded-md text-[11px] font-medium text-center transition cursor-pointer ${
                            isSelected
                              ? "bg-foreground text-background shadow-xs font-semibold"
                              : "text-muted hover:text-foreground"
                          }`}
                        >
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Custom Preview Text Hook Input */}
              <div className="pt-2 border-t border-border flex items-center gap-2">
                <Type className="w-3.5 h-3.5 text-muted shrink-0" />
                <input
                  type="text"
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  placeholder="Type custom test phrase for player preview..."
                  className="w-full bg-field px-2.5 py-1.5 rounded-md border border-border text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-foreground"
                />
              </div>
            </div>

            {/* Category Filter Tabs */}
            <div className="flex items-center gap-1 overflow-x-auto pb-0.5 scrollbar-none">
              {[
                { id: "all", label: "All" },
                { id: "viral", label: "Viral" },
                { id: "pill", label: "Pills" },
                { id: "neon", label: "Neon" },
                { id: "cinematic", label: "Cinematic" },
              ].map((tab) => {
                const isTabActive = activeCategory === tab.id;
                return (
                  <button
                    type="button"
                    key={tab.id}
                    onClick={() => setActiveCategory(tab.id)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition cursor-pointer whitespace-nowrap ${
                      isTabActive
                        ? "bg-foreground text-background font-semibold"
                        : "bg-surface-secondary text-muted hover:text-foreground"
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* 13 Native CSS Typography Theme Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[380px] overflow-y-auto pr-1">
              {filteredThemes.map((theme) => {
                const isSelected = selectedTheme === theme.id;
                return (
                  <button
                    type="button"
                    key={theme.id}
                    onClick={() => onSelectTheme(theme.id)}
                    className={`p-2.5 rounded-lg border text-left transition-all cursor-pointer flex flex-col justify-between group ${
                      isSelected
                        ? "border-foreground bg-surface-secondary shadow-xs ring-1 ring-foreground/20"
                        : "border-border bg-surface hover:border-muted hover:bg-surface-secondary/50"
                    }`}
                  >
                    {/* Top Row: Title & Checkmark */}
                    <div className="flex items-center justify-between gap-1 w-full mb-1.5">
                      <span className="text-xs font-semibold text-foreground truncate">
                        {theme.name}
                      </span>

                      {isSelected ? (
                        <div className="w-3.5 h-3.5 rounded-full bg-foreground text-background flex items-center justify-center shrink-0">
                          <Check className="w-2.5 h-2.5 stroke-[3]" />
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          {theme.colors.map((c, i) => (
                            <div
                              key={i}
                              className="w-1.5 h-1.5 rounded-full border border-black/20"
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Middle: Native CSS Typography Preview Box */}
                    <div className="w-full py-2.5 px-2 rounded bg-neutral-950 border border-neutral-800 flex items-center justify-center overflow-hidden">
                      {renderSubtitleContainer(
                        theme.id,
                        <>
                          {renderThemeText(theme.id, theme.sampleWords[0], false)}
                          {" "}
                          {renderThemeText(theme.id, theme.sampleWords[1], true)}
                          {" "}
                          {renderThemeText(theme.id, theme.sampleWords[2], false)}
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-8 rounded-xl bg-surface-secondary/40 border border-dashed border-border text-center space-y-2">
          <div className="text-sm font-medium text-foreground">Captions Disabled</div>
          <p className="text-xs text-muted max-w-md mx-auto">
            Videos will be cropped to 9:16 vertical without on-screen burned subtitles. Toggle "Burn in captions" above to re-enable animated captions.
          </p>
        </div>
      )}
    </div>
  );
};
