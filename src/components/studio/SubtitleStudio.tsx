import React, { useState, useEffect } from "react";
import {
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  Captions,
  Check,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { Label, Switch } from "@heroui/react";
import { Button } from "../ui/Button";
import { SectionCard } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Segmented } from "../ui/Segmented";

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
    description: "High-tempo slanted energy with toxic green glow",
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

// Fixed preview phrase for the 9:16 monitor.
const DEFAULT_PREVIEW_TEXT = "THIS NEW AI TOOL CHANGES EVERYTHING";

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
  isActive?: boolean;
  aspectRatio?: string;
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
  isActive = true,
  aspectRatio = "9:16",
}) => {
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [activeWordIndex, setActiveWordIndex] = useState<number>(0);
  const [showGuides, setShowGuides] = useState<boolean>(false);

  // Split the default preview phrase into words
  const words = React.useMemo(() => {
    const raw = DEFAULT_PREVIEW_TEXT.trim()
      ? DEFAULT_PREVIEW_TEXT.trim().split(/\s+/)
      : ["AI", "CREATES", "MAGIC"];
    return raw.map((w, idx) => {
      if (casing === "uppercase") return w.toUpperCase();
      if (casing === "title")
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      if (casing === "sentence")
        return idx === 0
          ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
          : w.toLowerCase();
      return w;
    });
  }, [casing]);

  // Real-time animation ticker
  useEffect(() => {
    if (!isActive || !burnInCaptions || !isPlaying || words.length === 0) return;
    const interval = setInterval(() => {
      setActiveWordIndex((prev) => (prev + 1) % words.length);
    }, 450);
    return () => clearInterval(interval);
  }, [isActive, burnInCaptions, isPlaying, words.length]);

  // Filtered themes
  const filteredThemes = React.useMemo(() => {
    if (activeCategory === "all") return SUBTITLE_THEMES;
    return SUBTITLE_THEMES.filter((t) => t.category === activeCategory);
  }, [activeCategory]);

  // Caption contract shared with video-use/helpers/render.py (words_to_ass).
  // The render canvas is 1080x1920; the monitor is a fluid-width column,
  // so preview sizes use container-query widths (FontSize px / 1080) and
  // match the burn at ANY monitor width instead of only at 300px:
  // compact 42px -> 3.89cqw, standard 50px -> 4.63cqw, large 60px -> 5.56cqw.
  // Punch burns single words at 88/104/125px -> 8.15/9.63/11.57cqw.
  // (The px fallback before each cqw class covers engines without
  // container-query units.) Positions mirror MarginV as % of height:
  // top 140 -> 7.3%, exact middle <-> Alignment 5, bottom 200 -> 10.4%.
  // Spoken-word highlight is color-only (no scale, no opacity fade) so a
  // selected caption stays the same size and fully visible, matching the burn.
  // Keep these fractions in sync when either side changes.
  const getSizeClasses = () => {
    if (selectedTheme === "punch") {
      switch (size) {
        case "compact":
          return "text-[24px] text-[8.15cqw] leading-none tracking-wide";
        case "large":
          return "text-[34px] text-[11.57cqw] leading-none tracking-wide";
        case "standard":
        default:
          return "text-[29px] text-[9.63cqw] leading-none tracking-wide";
      }
    }
    switch (size) {
      case "compact":
        return "text-xs text-[3.89cqw] leading-none tracking-tight";
      case "large":
        return "text-base text-[5.56cqw] leading-none tracking-wide";
      case "standard":
      default:
        return "text-sm text-[4.63cqw] leading-none tracking-normal";
    }
  };

  const getPositionClasses = () => {
    switch (position) {
      case "top":
        return "top-[7.3%]";
      case "center":
        return "top-1/2 -translate-y-1/2";
      case "bottom":
      default:
        return "bottom-[10.4%]";
    }
  };

  // Rolling cue window, mirroring the renderer's cue chunking
  // (cue_size_for_style: 1 word for punch, 2 for every other theme). The
  // burned output shows one cue at a time with only the spoken word
  // highlighted, so the preview shows exactly the active cue — not the
  // whole phrase — with the same active-word emphasis.
  const wordsPerCue = selectedTheme === "punch" ? 1 : 2;
  const activeCueStart =
    Math.floor(activeWordIndex / wordsPerCue) * wordsPerCue;
  const activeCueWords = words.slice(
    activeCueStart,
    activeCueStart + wordsPerCue,
  );

  // Helper to render active word styling based on theme
  const renderThemeText = (themeId: string, word: string, isActive: boolean) => {
    switch (themeId) {
      case "pop":
        return (
          <span
            className={`inline-block font-black uppercase ${
              isActive ? "text-[#FFE500]" : "text-white"
            }`}
            style={
              isActive
                ? {
                    textShadow:
                      "2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 0 1px 0 #a38f00, 0 2px 0 #8a7900, 0 3px 0 #6e6100, 0 4px 0 #57500a, 0 5px 0 #000, 0 8px 14px rgba(0,0,0,0.8)",
                  }
                : {
                    textShadow:
                      "2px 2px 0 #000, -1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000",
                  }
            }
          >
            {word}
          </span>
        );

      case "spotlight":
        return isActive ? (
          <span className="inline-block rounded-full bg-[#7C3AED] px-2 py-0.5 font-bold text-white shadow-md shadow-purple-900/50">
            {word}
          </span>
        ) : (
          <span
            className="inline-block font-bold text-white"
            style={{ textShadow: "0 2px 4px rgba(0,0,0,0.9)" }}
          >
            {word}
          </span>
        );

      case "glow":
        return (
          <span
            className={`inline-block font-extrabold uppercase tracking-wide ${
              isActive ? "text-[#00F5FF]" : "text-white"
            }`}
            style={
              isActive
                ? {
                    textShadow:
                      "0 0 8px rgba(0,245,255,0.95), 0 0 22px rgba(0,245,255,0.6), 0 0 46px rgba(0,245,255,0.35)",
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
            className={`inline-block font-bold tracking-tight ${
              isActive ? "text-[#FACC15]" : "text-neutral-100"
            }`}
          >
            {word}
          </span>
        );

      case "editorial":
        return (
          <span
            className={`inline-block font-serif tracking-wide italic ${
              isActive
                ? "text-[#EAB308] underline decoration-2 underline-offset-4"
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
            className={`inline-block -skew-x-6 font-black tracking-tight uppercase ${
              isActive ? "text-[#22C55E]" : "text-white"
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
            className="inline-block font-black tracking-wider text-white uppercase"
            style={{
              textShadow:
                "2.5px 2.5px 0 #000, -1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000",
            }}
          >
            {word}
          </span>
        );

      case "paper":
        return (
          <span
            className={`inline-block font-bold tracking-tight ${
              isActive ? "font-black text-[#7C3AED]" : "text-neutral-900"
            }`}
          >
            {word}
          </span>
        );

      case "subtle":
        return (
          <span
            className={`inline-block font-normal tracking-normal ${
              isActive ? "font-medium text-[#FBBF24]" : "text-neutral-400"
            }`}
          >
            {word}
          </span>
        );

      default:
        return <span>{word}</span>;
    }
  };

  // Wrapper for boxed / paper container backgrounds
  // (subtle is intentionally bare text with no backing container)
  const renderSubtitleContainer = (
    themeId: string,
    children: React.ReactNode,
  ) => {
    if (themeId === "boxed") {
      return (
        <div className="inline-flex flex-wrap items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-black px-3.5 py-1.5 shadow-2xl">
          {children}
        </div>
      );
    }
    if (themeId === "paper") {
      return (
        <div className="inline-flex flex-wrap items-center justify-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 shadow-xl">
          {children}
        </div>
      );
    }
    return (
      <div className="inline-flex flex-wrap items-center justify-center gap-1.5 px-2">
        {children}
      </div>
    );
  };

  const settingRow = (label: string, control: React.ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {control}
    </div>
  );

  const captionSwitch = (
    <Switch
      size="sm"
      isSelected={burnInCaptions}
      onChange={onToggleBurnInCaptions}
      aria-label="Burn in captions"
    >
      <Switch.Content>
        <Label className="text-sm text-muted">Burn in</Label>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );

  if (!burnInCaptions) {
    return (
      <SectionCard
        title="Captions"
        description="Export your video without on-screen captions"
        actions={captionSwitch}
      >
        <EmptyState
          compact
          icon={<Captions />}
          title="Captions are off"
          description="Turn on burn-in to add animated, word-timed captions and pick a style."
        />
      </SectionCard>
    );
  }

  return (
    <div className="studio-caption-layout grid items-start gap-5">
      {/* 9:16 monitor */}
      <div className="studio-caption-sample mx-auto w-full max-w-[14rem]">
        <div className="overflow-hidden rounded-3xl bg-surface shadow-surface">
          <div className="flex min-h-12 items-center border-b border-separator px-3 py-2">
            <span className="text-xs font-semibold text-foreground">
              Caption style sample
            </span>
          </div>

          {/* Viewport (container queries scale captions to any width) */}
          <div className="@container relative flex w-full flex-col justify-between overflow-hidden bg-neutral-950 select-none" style={{ aspectRatio: aspectRatio.replace(":", "/") }}>
            <div className="absolute inset-0 bg-neutral-950">
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_35%,rgba(255,255,255,0.05),transparent)]" />
              <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black/80 to-transparent" />
            </div>

            {showGuides && (
              <div className="pointer-events-none absolute inset-3 z-10 flex flex-col justify-between rounded-sm border border-white/10">
                <div className="border-b border-dashed border-white/15 p-1 text-[8px] tracking-wider text-white/30 uppercase">
                  Top safe margin
                </div>
                <div className="border-t border-dashed border-white/15 p-1 text-right text-[8px] tracking-wider text-white/30 uppercase">
                  Action safe area
                </div>
              </div>
            )}

            <div className="relative z-20 flex items-center justify-between px-3 pt-2.5 text-[10px] text-white/70">
              <span className="max-w-[180px] truncate rounded bg-black/50 px-1.5 py-0.5 text-[9px]">
                {videoTitle || "Untitled short"}
              </span>
              <span className="tabular-nums text-[9px] text-white/40">
                {activeWordIndex + 1}/{words.length}
              </span>
            </div>

            <div
              className={`pointer-events-none absolute inset-x-[3.7%] z-20 text-center ${getPositionClasses()} ${getSizeClasses()}`}
            >
              {renderSubtitleContainer(
                selectedTheme,
                <>
                  {activeCueWords.map((word, idx) => (
                    <React.Fragment key={activeCueStart + idx}>
                      {renderThemeText(
                        selectedTheme,
                        word,
                        activeCueStart + idx === activeWordIndex,
                      )}{" "}
                    </React.Fragment>
                  ))}
                </>,
              )}
            </div>

            <div className="relative z-20 h-0.5 w-full bg-white/10">
              <div
                className="h-full bg-white/70 transition-all duration-200"
                style={{
                  width: `${((activeWordIndex + 1) / Math.max(1, words.length)) * 100}%`,
                }}
              />
            </div>
          </div>

          {/* Transport */}
          <div className="flex h-11 items-center justify-between border-t border-separator px-3">
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={isPlaying ? <Pause /> : <Play />}
                onClick={() => setIsPlaying(!isPlaying)}
                aria-label={isPlaying ? "Pause preview" : "Play preview"}
                className="size-7"
              />
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<RotateCcw />}
                onClick={() => setActiveWordIndex(0)}
                aria-label="Restart preview"
                className="size-7"
              />
            </div>
            <Button
              variant={showGuides ? "tertiary" : "ghost"}
              size="sm"
              onClick={() => setShowGuides(!showGuides)}
              aria-pressed={showGuides}
              className="h-7"
            >
              Safe areas
            </Button>
          </div>
        </div>
      </div>

      <div className="min-w-0 space-y-5">
        <SectionCard
          title="Captions"
          description="Word-timed captions burned into the render"
          actions={captionSwitch}
          contentClassName="p-0 divide-y divide-separator"
        >
          {settingRow(
            "Position",
            <Segmented<SubtitlePosition>
              label="Caption position"
              value={position}
              onChange={onChangePosition}
              options={[
                {
                  value: "top",
                  label: "Top",
                  icon: <AlignVerticalJustifyStart />,
                },
                {
                  value: "center",
                  label: "Middle",
                  icon: <AlignVerticalJustifyCenter />,
                },
                {
                  value: "bottom",
                  label: "Bottom",
                  icon: <AlignVerticalJustifyEnd />,
                },
              ]}
            />,
          )}
          {settingRow(
            "Size",
            <Segmented<SubtitleSize>
              label="Caption size"
              value={size}
              onChange={onChangeSize}
              options={[
                { value: "compact", label: "Small" },
                { value: "standard", label: "Medium" },
                { value: "large", label: "Large" },
              ]}
            />,
          )}
          {settingRow(
            "Casing",
            <Segmented<SubtitleCase>
              label="Caption casing"
              value={casing}
              onChange={onChangeCasing}
              options={[
                { value: "uppercase", label: "ABC" },
                { value: "title", label: "Abc" },
                { value: "sentence", label: "abc" },
              ]}
            />,
          )}
        </SectionCard>

        <SectionCard
          title="Style"
          description={
            SUBTITLE_THEMES.find((t) => t.id === selectedTheme)?.description ??
            "Pick a caption style"
          }
          actions={
            <Segmented
              label="Caption style category"
              value={activeCategory}
              onChange={setActiveCategory}
              options={[
                { value: "all", label: "All" },
                { value: "viral", label: "Viral" },
                { value: "pill", label: "Pill" },
                { value: "neon", label: "Neon" },
                { value: "cinematic", label: "Cinematic" },
              ]}
            />
          }
        >
          <div
            role="radiogroup"
            aria-label="Caption style"
            className="studio-caption-options grid gap-3"
          >
            {filteredThemes.map((theme) => {
              const isSelected = selectedTheme === theme.id;
              return (
                <button
                  type="button"
                  key={theme.id}
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => onSelectTheme(theme.id)}
                  title={theme.description}
                  className={`overflow-hidden rounded-lg border text-left transition-colors ${
                    isSelected
                      ? "border-accent ring-2 ring-accent/20"
                      : "border-border hover:border-border-tertiary"
                  }`}
                >
                  <div className="flex h-16 w-full items-center justify-center overflow-hidden bg-neutral-950 px-2">
                    {renderSubtitleContainer(
                      theme.id,
                      <>
                        {renderThemeText(theme.id, theme.sampleWords[0], false)}{" "}
                        {renderThemeText(theme.id, theme.sampleWords[1], true)}{" "}
                        {renderThemeText(theme.id, theme.sampleWords[2], false)}
                      </>,
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-separator px-2.5 py-2">
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">
                      {theme.name}
                      <span className="ml-1.5 font-normal text-muted">
                        {theme.tag}
                      </span>
                    </span>
                    {isSelected ? (
                      <Check className="size-3.5 shrink-0 text-accent" strokeWidth={3} />
                    ) : (
                      <span className="flex shrink-0 items-center -space-x-0.5">
                        {theme.colors.map((c, i) => (
                          <span
                            key={i}
                            className="size-2.5 rounded-full ring-1 ring-surface"
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </SectionCard>
      </div>
    </div>
  );
};
