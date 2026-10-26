export type TranscriptionProvider = "local" | "elevenlabs";
export const TRANSCRIPTION_PROVIDER_KEY = "2pixel_transcription_provider";

interface Storage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function loadTranscriptionProvider(storage?: Pick<Storage, "getItem">): TranscriptionProvider {
  try {
    const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    return store?.getItem(TRANSCRIPTION_PROVIDER_KEY) === "elevenlabs" ? "elevenlabs" : "local";
  } catch { return "local"; }
}

export function saveTranscriptionProvider(provider: TranscriptionProvider, storage?: Storage): void {
  const store = storage ?? localStorage;
  store.setItem(TRANSCRIPTION_PROVIDER_KEY, provider);
}

/** A saved cloud key never changes the provider, and stays out of local jobs. */
export function transcriptionInvokeParams(key?: string, provider = loadTranscriptionProvider()) {
  return { transcriptionProvider: provider, elevenlabsKey: provider === "elevenlabs" ? key?.trim() || null : null };
}
