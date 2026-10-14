import type { ScheduleItem, ZernioAccount } from "../types";

/**
 * Channel connection gating — single source of truth for what the Social
 * page may show as linked, selectable, or dispatchable.
 *
 * Rule: a platform counts as connected ONLY when the gateway account list
 * says so. Nothing here may default, assume, or invent a connection.
 */

/** Gateway slug used by the app. The accounts list sometimes reports X as `x`. */
export function canonicalPlatformId(platform: string): string {
  const id = platform.trim().toLowerCase();
  return id === "x" ? "twitter" : id;
}

/** True only when the gateway reports this platform linked. */
export function isPlatformConnected(
  accounts: ZernioAccount[],
  platformId: string,
): boolean {
  const wanted = canonicalPlatformId(platformId);
  return accounts.some(
    (a) => canonicalPlatformId(a.platform) === wanted && a.is_connected,
  );
}

/** Lowercased ids of gateway-linked platforms. Empty when logged out. */
export function connectedPlatformIds(accounts: ZernioAccount[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const account of accounts) {
    if (!account.is_connected) continue;
    const id = canonicalPlatformId(account.platform);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Honest row label — username, else account name, else generic. Never invents a handle. */
export function accountLabel(
  acc: Pick<ZernioAccount, "username" | "name">,
): string {
  return acc.username || acc.name || "Connected";
}

/** Drop selected ids that are no longer connected. */
export function pruneSelection(
  selected: string[],
  accounts: ZernioAccount[],
): string[] {
  const connected = new Set(connectedPlatformIds(accounts));
  return selected.filter((p) => connected.has(p.toLowerCase()));
}

/** Dispatch is allowed only with an API key and ≥1 connected channel selected. */
export function canDispatch(
  apiKey: string,
  selected: string[],
  accounts: ZernioAccount[],
): boolean {
  if (!apiKey.trim() || selected.length === 0) return false;
  return pruneSelection(selected, accounts).length === selected.length;
}

/**
 * Best-effort post id from a Zernio create-post response body.
 * The id nests at `post._id` in current responses (or `data.post._id` in
 * SDK-style envelopes); older/flat shapes (`post.id`, `_id`, `id`, `postId`,
 * `post_id`) are accepted too. Null when the body is not JSON or carries no
 * id — callers must treat that as "remote sync unavailable", never as a
 * failure.
 */
export function extractPostId(text: string): string | null {
  let val: unknown;
  try {
    val = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof val !== "object" || val === null) return null;
  const obj = val as Record<string, unknown>;
  const asRec = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  const post = asRec(obj.post);
  const data = asRec(obj.data);
  const dataPost = data ? asRec(data.post) : null;
  const candidates = [
    post?.["_id"],
    post?.["id"],
    dataPost?.["_id"],
    dataPost?.["id"],
    data?.["_id"],
    data?.["id"],
    obj["_id"],
    obj["id"],
    obj["postId"],
    obj["post_id"],
    data?.["postId"],
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

/**
 * Best-effort post status from a Zernio create-post response body
 * (`post.status`, else `data.post.status`). Null when the body is not JSON
 * or carries no status.
 */
export function postStatusOf(text: string): string | null {
  let val: unknown;
  try {
    val = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof val !== "object" || val === null) return null;
  const obj = val as Record<string, unknown>;
  const statusOf = (v: unknown): string | null => {
    if (typeof v !== "object" || v === null) return null;
    const raw = (v as Record<string, unknown>)["status"];
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  };
  const data = obj.data;
  const dataPost =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)["post"]
      : null;
  return statusOf(obj.post) ?? statusOf(dataPost) ?? null;
}

/**
 * Per-platform failure lines from a create-post body
 * (`youtube: Token expired`). Null when nothing failed or the body is not JSON.
 */
export function platformFailureMessage(text: string): string | null {
  let val: unknown;
  try {
    val = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof val !== "object" || val === null) return null;
  const obj = val as Record<string, unknown>;
  const asRec = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  const post = asRec(obj.post) ?? asRec(asRec(obj.data)?.post);
  const platforms = post?.platforms;
  if (!Array.isArray(platforms)) return null;
  const lines: string[] = [];
  for (const entry of platforms) {
    const row = asRec(entry);
    if (!row) continue;
    const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
    if (status !== "failed") continue;
    const name = typeof row.platform === "string" ? row.platform : "platform";
    const reason =
      (typeof row.errorMessage === "string" && row.errorMessage) ||
      (typeof row.error === "string" && row.error) ||
      "no detail from gateway";
    lines.push(`${name}: ${reason}`);
  }
  if (lines.length === 0) return null;
  return `Zernio could not publish: ${lines.join(" | ")}`;
}

const REMOTE_COMPLETED = new Set([
  "published",
  "posted",
  "success",
  "completed",
  "delivered",
  "live",
]);
const REMOTE_FAILED = new Set(["failed", "error", "rejected"]);
const REMOTE_QUEUED = new Set(["scheduled", "queued", "pending", "draft"]);
const REMOTE_PUBLISHING = new Set([
  "publishing",
  "processing",
  "posting",
  "in_progress",
]);

/**
 * Map a gateway status string to a local queue status.
 * Returns null for unknown values — the caller keeps the local status
 * and shows the raw remote string instead of guessing.
 */
export function mapRemoteStatus(
  raw: string,
): ScheduleItem["status"] | null {
  const key = raw.trim().toLowerCase();
  if (REMOTE_COMPLETED.has(key)) return "completed";
  if (REMOTE_FAILED.has(key)) return "failed";
  if (REMOTE_QUEUED.has(key)) return "queued";
  if (REMOTE_PUBLISHING.has(key)) return "publishing";
  return null;
}
