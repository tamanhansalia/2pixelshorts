import type { SocialPublishPayload } from "../types/index.ts";
import type { KeyValueStorage } from "./channelProfiles.ts";
import { MAX_SEO_HASHTAGS, normalizeHashtag } from "./seo.ts";

/**
 * Publish-time extras that ride along without threading new fields through
 * every Studio → Social → Queue hop:
 * - the pinned first comment, saved per video path by the Studio;
 * - real hashtags, read back out of the description's hashtag line;
 * - the YouTube category from the default channel profile.
 * `enrichPublishPayload` fills only what the payload leaves empty.
 */

export const PINNED_COMMENTS_KEY = "2pixel_pinned_comments";
const MAX_PINNED_ENTRIES = 300;

/** YouTube category ids worth offering for Shorts creators. */
export const YOUTUBE_CATEGORIES: { id: string; label: string }[] = [
  { id: "28", label: "Science & Technology" },
  { id: "27", label: "Education" },
  { id: "22", label: "People & Blogs" },
  { id: "24", label: "Entertainment" },
  { id: "20", label: "Gaming" },
  { id: "26", label: "Howto & Style" },
  { id: "25", label: "News & Politics" },
  { id: "23", label: "Comedy" },
  { id: "10", label: "Music" },
  { id: "17", label: "Sports" },
];

export function createPinnedCommentStore(storage: KeyValueStorage) {
  const load = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(storage.getItem(PINNED_COMMENTS_KEY) ?? "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };
  return {
    get(videoPath: string): string {
      return (videoPath && load()[videoPath]) || "";
    },
    set(paths: string[], comment: string): void {
      const map = load();
      const text = comment.trim();
      for (const path of paths) {
        if (!path) continue;
        if (text) map[path] = text;
        else delete map[path];
      }
      // Oldest entries drop first (insertion order) past the cap.
      const entries = Object.entries(map).slice(-MAX_PINNED_ENTRIES);
      try {
        storage.setItem(
          PINNED_COMMENTS_KEY,
          JSON.stringify(Object.fromEntries(entries)),
        );
      } catch {
        // Storage blocked: the comment just will not ride along.
      }
    },
  };
}

function sharedStore() {
  return typeof localStorage !== "undefined"
    ? createPinnedCommentStore(localStorage)
    : null;
}

export const getPinnedComment = (videoPath: string) =>
  sharedStore()?.get(videoPath) ?? "";
export const setPinnedComment = (paths: string[], comment: string) =>
  sharedStore()?.set(paths, comment);

/** Postable hashtags found in a caption, deduped, in order. */
export function extractHashtags(
  text: string,
  limit: number = MAX_SEO_HASHTAGS,
): string[] {
  const out: string[] = [];
  for (const match of (text ?? "").matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)) {
    const tag = normalizeHashtag(match[2]);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= limit) break;
  }
  return out;
}

export function enrichPublishPayload(
  payload: SocialPublishPayload,
  extras: { pinnedComment?: string; youtubeCategory?: string },
): SocialPublishPayload {
  const hashtags =
    payload.hashtags && payload.hashtags.length
      ? payload.hashtags
      : extractHashtags(payload.description);
  const firstComment =
    payload.first_comment?.trim() || extras.pinnedComment?.trim() || "";
  const category =
    payload.youtube_category?.trim() || extras.youtubeCategory?.trim() || "";
  return {
    ...payload,
    ...(hashtags.length ? { hashtags } : {}),
    ...(firstComment ? { first_comment: firstComment } : {}),
    ...(category ? { youtube_category: category } : {}),
  };
}
