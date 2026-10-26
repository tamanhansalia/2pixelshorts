import { invoke } from "./invoke.ts";
import { API_KEY_ZERNIO, API_KEY_ELEVENLABS, API_KEY_YOUTUBE } from "./appReset.ts";

export type CredentialProvider = "zernio" | "elevenlabs" | "youtube";
export type ApiKeys = Record<CredentialProvider, string>;
export const EMPTY_API_KEYS: ApiKeys = { zernio: "", elevenlabs: "", youtube: "" };
const LEGACY_KEYS = { zernio: API_KEY_ZERNIO, elevenlabs: API_KEY_ELEVENLABS, youtube: API_KEY_YOUTUBE };

interface Vault {
  read(): Promise<ApiKeys>;
  write(provider: CredentialProvider, value: string): Promise<void>;
  clear(): Promise<void>;
}
interface LegacyStorage { getItem(key: string): string | null; removeItem(key: string): void }

export function createCredentialStore(vault: Vault, storage: LegacyStorage) {
  return {
    async load(): Promise<ApiKeys> {
      const keys = { ...EMPTY_API_KEYS, ...await vault.read() };
      for (const provider of Object.keys(LEGACY_KEYS) as CredentialProvider[]) {
        const storageKey = LEGACY_KEYS[provider];
        const legacy = storage.getItem(storageKey)?.trim();
        if (legacy && !keys[provider]) {
          await vault.write(provider, legacy);
          keys[provider] = legacy;
        }
        // Remove plaintext only after its secure copy exists. Failed writes
        // leave the original recoverable and propagate an actionable error.
        storage.removeItem(storageKey);
      }
      return keys;
    },
    async save(provider: CredentialProvider, value: string) {
      await vault.write(provider, value.trim());
      storage.removeItem(LEGACY_KEYS[provider]);
    },
    async clear() {
      await vault.clear();
      for (const key of Object.values(LEGACY_KEYS)) storage.removeItem(key);
    },
  };
}

const isDesktop = () => "__TAURI_INTERNALS__" in window;
const previewKeys = { ...EMPTY_API_KEYS };
function store() {
  return createCredentialStore({
    read: () => isDesktop() ? invoke<ApiKeys>("get_api_keys") : Promise.resolve({ ...previewKeys }),
    write: async (provider, value) => {
      if (isDesktop()) await invoke("set_api_key", { provider, value });
      else previewKeys[provider] = value;
    },
    clear: async () => {
      if (isDesktop()) await invoke("clear_api_keys");
      else Object.assign(previewKeys, EMPTY_API_KEYS);
    },
  }, localStorage);
}
// Concurrent callers share one pending load. A failed load clears itself so a
// denied macOS keychain prompt can be retried.
export function singleFlight<T>(load: () => Promise<T>) {
  let pending: Promise<T> | null = null;
  return {
    get() {
      if (!pending) {
        pending = load().catch((error) => {
          pending = null;
          throw error;
        });
      }
      return pending;
    },
    reset() { pending = null; },
  };
}
// Each keychain read can prompt for the macOS login password. StrictMode mounts
// effects twice in dev, so the desktop read must be shared, not repeated.
const keychainKeys = singleFlight(() => store().load());
// Preview credentials are session-only; production persistence uses the OS vault.
export const loadApiKeys = () => isDesktop() ? keychainKeys.get() : Promise.resolve({ ...previewKeys });
export const saveApiKey = async (provider: CredentialProvider, value: string) => {
  await store().save(provider, value);
  keychainKeys.reset();
};
export const clearApiKeys = async () => {
  await store().clear();
  keychainKeys.reset();
};
