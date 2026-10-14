/** Video extensions accepted from a native file drop (lowercase). */
export const VIDEO_DROP_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".ts",
  ".flv",
  ".wmv",
  ".3gp",
];

/**
 * Pick the best source-video candidate from native drop paths.
 *
 * Prefers the first path with a video extension; falls back to the first
 * path (ffprobe validates it during probe); null when nothing was dropped.
 */
export function pickDroppedVideo(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const video = paths.find((p) =>
    VIDEO_DROP_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext)),
  );
  return video ?? paths[0];
}

/**
 * Hit-test a Tauri drag-drop position against a DOM rect.
 *
 * Tauri reports positions in physical pixels relative to the webview's
 * top-left corner while getBoundingClientRect() is in CSS pixels, so the
 * position is scaled down by the display scale factor first. True when the
 * drop point lands inside the rect (edges inclusive).
 */
export function isDropOverRect(
  pos: { x: number; y: number },
  rect: { left: number; right: number; top: number; bottom: number },
  scaleFactor: number,
): boolean {
  const scale = scaleFactor > 0 ? scaleFactor : 1;
  const x = pos.x / scale;
  const y = pos.y / scale;
  return (
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  );
}

export type BrowserFileKind =
  | { kind: "path"; path: string }
  | { kind: "name-only"; name: string }
  | { kind: "empty" };

/**
 * Classify a DOM-dropped file for the browser fallback.
 *
 * Only runtimes that expose a filesystem path on the File (e.g. Electron,
 * or a Tauri dialog result) yield a real `path`. Plain browsers expose just
 * `name`, which is not a resolvable file location — callers must say so
 * instead of probing it as if it were real.
 */
export function classifyBrowserFile(file: {
  path?: string;
  name?: string;
} | null | undefined): BrowserFileKind {
  const rawPath = file?.path?.trim();
  if (rawPath) return { kind: "path", path: rawPath };
  const rawName = file?.name?.trim();
  if (rawName) return { kind: "name-only", name: rawName };
  return { kind: "empty" };
}
