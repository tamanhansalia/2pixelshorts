/**
 * Channel context profiles: global per-channel defaults (niche, audience,
 * tone, CTA) with a per-video override at render time.
 *
 * Resolution rule: a non-blank per-video override wins, otherwise the
 * default profile renders to text. Both the agent cut prompt and the SEO
 * generator consume the resolved string.
 */

export interface ChannelProfile {
  id: string;
  name: string;
  niche: string;
  audience: string;
  tone: string;
  cta: string;
  keywords: string[];
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PROFILES_KEY = "2pixel_channel_profiles";
export const DEFAULT_KEY = "2pixel_default_channel";
export const LEGACY_CONTEXT_KEY = "tuari_channel_context";

export const LEGACY_DEFAULT =
  "This is my channel about AI development, code tools, open-source agents, building SaaS apps and tutorials for programmers.";

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function defaultStorage(): KeyValueStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  return memoryStorage();
}

export function seedProfiles(storage: KeyValueStorage): ChannelProfile[] {
  // One-time migration: a customized legacy free-text context becomes the
  // default profile's niche instead of being dropped.
  let niche =
    "AI development, code tools, open-source agents, building SaaS apps and tutorials for programmers";
  try {
    const legacy = storage.getItem(LEGACY_CONTEXT_KEY);
    if (legacy && legacy.trim() && legacy.trim() !== LEGACY_DEFAULT) {
      niche = legacy.trim();
    }
  } catch {
    // Storage unavailable; fall through to built-in defaults.
  }
  return [
    {
      id: "2pixelspace",
      name: "2PixelSpace",
      niche,
      audience: "Engineers, developers, and tech builders",
      tone: "Fast-paced, punchy, and practical",
      cta: "Subscribe for daily tech & developer guides!",
      keywords: ["ai tools", "coding agents", "tauri", "rust", "saas"],
    },
  ];
}

export function createProfileStore(storage: KeyValueStorage) {
  return {
    loadProfiles(): ChannelProfile[] {
      try {
        const raw = storage.getItem(PROFILES_KEY);
        if (!raw) {
          const seeded = seedProfiles(storage);
          storage.setItem(PROFILES_KEY, JSON.stringify(seeded));
          return seeded;
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return seedProfiles(storage);
        }
        return parsed as ChannelProfile[];
      } catch {
        return seedProfiles(storage);
      }
    },

    saveProfiles(profiles: ChannelProfile[]): void {
      storage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    },

    getDefaultProfileId(): string | null {
      try {
        return storage.getItem(DEFAULT_KEY);
      } catch {
        return null;
      }
    },

    setDefaultProfileId(id: string | null): void {
      if (id) storage.setItem(DEFAULT_KEY, id);
      else storage.removeItem(DEFAULT_KEY);
    },

    getDefaultProfile(): ChannelProfile | null {
      const profiles = this.loadProfiles();
      if (profiles.length === 0) return null;
      const id = this.getDefaultProfileId();
      return profiles.find((p) => p.id === id) ?? profiles[0];
    },
  };
}

const sharedStore = createProfileStore(defaultStorage());

export const loadProfiles = () => sharedStore.loadProfiles();
export const saveProfiles = (p: ChannelProfile[]) => sharedStore.saveProfiles(p);
export const getDefaultProfileId = () => sharedStore.getDefaultProfileId();
export const setDefaultProfileId = (id: string | null) =>
  sharedStore.setDefaultProfileId(id);
export const getDefaultProfile = () => sharedStore.getDefaultProfile();

export function renderProfileText(profile: ChannelProfile): string {
  const lines = [
    `Channel: ${profile.name}`,
    `Niche: ${profile.niche}`,
    `Audience: ${profile.audience}`,
    `Tone: ${profile.tone}`,
    `CTA: ${profile.cta}`,
  ];
  if (profile.keywords.length > 0) {
    lines.push(`Keywords: ${profile.keywords.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Resolve the effective channel context: per-video override wins when
 * non-blank, otherwise the default profile rendered as text.
 */
export function getEffectiveContext(
  override?: string | null,
  store = sharedStore,
): string {
  if (override && override.trim()) return override.trim();
  const profile = store.getDefaultProfile();
  if (!profile) return "";
  return renderProfileText(profile);
}
