export const STUDIO_STAGES = [
  { id: "source", label: "Video", title: "Add a video", description: "Drop a recording, or paste a public YouTube link or a finished Twitch VOD. A live stream waits here until the replay is published." },
  { id: "edit", label: "Edit", title: "Choose the cut", description: "Clean the recording, or let an installed CLI pick a highlight. Framing and color stay on this computer." },
  { id: "captions", label: "Captions", title: "Caption every word", description: "Pick a style, size and position. The sample is the style; Export burns it onto your footage." },
  { id: "title", label: "Title", title: "Name the short", description: "An installed CLI writes the title, description and tags. Auto cut uses that CLI too. You can edit every line." },
  { id: "render", label: "Export", title: "Export the short", description: "Save the MP4, then schedule it. Due posts go out while 2pixelshorts is open." },
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
