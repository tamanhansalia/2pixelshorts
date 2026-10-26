import { notify } from "../../lib/notify";
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { FolderOpen, Play } from "lucide-react";
import { isTauri, probeVideo } from "../../lib/ipc";
import { SectionCard } from "../ui/Card";
import { Button } from "../ui/Button";

interface VideoPreviewProps {
  inputPath: string;
  /** Newest completed render for this source, when one exists. */
  completedOutput: string | null;
  completedVersion: string;
  /** Output of the live job in this view, when it just finished. */
  jobOutput: string | null;
  jobVersion: string;
  onOpenFile: (path: string) => void;
  onReveal: (path: string) => void;
}

/**
 * Always-visible preview: the source video, with an Original/Edited
 * toggle once a render exists. Lives beside the active Studio stage.
 */
export function VideoPreview({ inputPath, completedOutput, completedVersion, jobOutput, jobVersion,
  onOpenFile, onReveal }: VideoPreviewProps) {
  const output = jobOutput ?? completedOutput;
  const [view, setView] = useState<"source" | "output">(output ? "output" : "source");
  const [readyPath, setReadyPath] = useState("");
  const [previewError, setPreviewError] = useState("");
  useEffect(() => {
    if (previewError) notify("Preview unavailable", previewError, "error");
  }, [previewError]);
  const path = view === "output" && output ? output : inputPath;
  const revision = view === "output" ? (jobOutput ? jobVersion : completedVersion) : "";
  useEffect(() => { setView(output ? "output" : "source"); }, [inputPath, output, jobVersion, completedVersion]);
  useEffect(() => {
    let active = true;
    setReadyPath(""); setPreviewError("");
    if (isTauri() && path) {
      // Re-authorize only this real file after app restart or completion.
      void probeVideo(path).then(() => { if (active) setReadyPath(path); })
        .catch(error => { if (active) setPreviewError(error instanceof Error ? error.message : "Preview unavailable"); });
    }
    return () => { active = false; };
  }, [path, revision]);
  return <SectionCard className="studio-preview-card" title={view === "output" && output ? "Edited video" : "Original video"}
    actions={output ? <div className="flex gap-1">
      <Button size="sm" variant={view === "source" ? "secondary" : "ghost"} onClick={() => setView("source")}>Original</Button>
      <Button size="sm" variant={view === "output" ? "secondary" : "ghost"} onClick={() => setView("output")}>Edited</Button>
    </div> : undefined}>
    {readyPath === path && path ? <video key={`${path}:${revision}`} src={`${convertFileSrc(path)}${revision ? `?render=${encodeURIComponent(revision)}` : ""}`} controls preload="metadata"
      aria-label={view === "output" && output ? "Edited video preview" : "Original video preview"}
      className="max-h-[min(28rem,52vh)] min-h-48 w-full rounded-lg bg-black object-contain"
      onError={() => setPreviewError("The in-app player could not open this file. Use Open video to play it in your system player.")} />
      : <div className="flex min-h-48 items-center justify-center rounded-lg bg-surface-secondary p-5 text-center text-sm text-muted">{previewError ? "Preview unavailable" : isTauri() ? "Loading video…" : "Open the desktop app to preview your video."}</div>}
    <div className="mt-3 flex flex-wrap justify-end gap-2">
      <Button variant="ghost" size="sm" icon={<FolderOpen />} disabled={!isTauri()} onClick={() => onReveal(path)}>Show file</Button>
      <Button variant="secondary" size="sm" icon={<Play />} disabled={!isTauri()} onClick={() => onOpenFile(path)}>Open video</Button>
    </div>
  </SectionCard>;
}
