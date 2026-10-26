import type { RenderShortParams } from "../types/index.ts";

/** custom is accepted only to migrate drafts from the old exclusive mode. */
export type EditStrategy = "cleanup" | "highlights" | "full" | "custom";
export function normalizeEditStrategy(value: unknown): Exclude<EditStrategy, "custom"> {
  return value === "highlights" || value === "full" ? value : "cleanup";
}

/** Keep automatic re-exports distinct so history entries still play their own edits. */
export function nextAutomaticExport(path: string, strategy: EditStrategy, usedPaths: string[]): string {
  const used = new Set(usedPaths);
  if (!used.has(path)) return path;
  const stem = path.replace(/\.mp4$/i, "").replace(/-(cleanup|highlights|full)(-\d+)?$/, "");
  const base = `${stem}-${normalizeEditStrategy(strategy)}`;
  let candidate = `${base}.mp4`;
  for (let index = 2; used.has(candidate); index++) candidate = `${base}-${index}.mp4`;
  return candidate;
}
export function automationParams(strategy: EditStrategy, agent: string, target: number,
  removeSilence: boolean, removeRetakes: boolean, prompt = "", instructionsEnabled = true,
  model = ""): Partial<RenderShortParams> {
  const mode = normalizeEditStrategy(strategy);
  const instructions = instructionsEnabled ? prompt.trim() : "";
  const usesAgent = mode === "highlights" || Boolean(instructions);
  return {
    edit_strategy: mode,
    agent_id: usesAgent ? agent : "auto",
    model_id: usesAgent ? model.trim() || undefined : undefined,
    prompt_hook: instructions || undefined,
    target_duration: mode === "highlights" ? target : undefined,
    remove_silence: removeSilence,
    remove_retakes: removeRetakes,
  };
}
