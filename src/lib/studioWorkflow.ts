export const STUDIO_STAGES = [
  { id: "source", label: "Video", title: "Choose your video", description: "Start with a recording on your computer, or find moments from a public video link." },
  { id: "edit", label: "Edit & format", title: "Make it your own", description: "Choose what to keep, then set the look and framing. Your original file stays intact." },
  { id: "captions", label: "Captions", title: "Give every word a voice", description: "Choose a caption style, size and position. The sample shows the style; render to see it on your video." },
  { id: "title", label: "Title & tags", title: "Get ready to share", description: "Review your title, description and tags. These are optional — you can export without them." },
  { id: "render", label: "Export", title: "Review & export", description: "Check your choices and save the finished video. You can keep working while it renders." },
] as const;

export type StudioStage = typeof STUDIO_STAGES[number]["id"];

export function resolveStudioStage(value: unknown, hasVideo: boolean): StudioStage {
  if (!hasVideo) return "source";
  return STUDIO_STAGES.find(stage => stage.id === value)?.id ?? "edit";
}

/**
 * Which saved stream Studio should reopen on mount.
 *
 * Plus / "new short" stays empty so the last YouTube run cannot refill the
 * form. A busy clip job still reopens when returning to Studio. A loaded
 * file source wins over recents.
 */
export type StreamRestoreMode = "none" | "busy-job" | "recent-run";

export function resolveStreamRestore(input: {
  startBlank: boolean;
  hasSourceInput: boolean;
  hasBusyClipJob: boolean;
}): StreamRestoreMode {
  if (input.startBlank) return "none";
  if (input.hasBusyClipJob) return "busy-job";
  if (input.hasSourceInput) return "none";
  return "recent-run";
}
