import { Toast } from "@heroui/react";

/**
 * App-wide notifications, built on HeroUI v3's toast queue.
 * Pair with <AppToasts /> (mounted once in App) which renders Toast.Provider.
 */
export type NotifyKind = "success" | "error" | "info" | "warning";

const recentNotifications = new Map<string, number>();

export function notify(
  title: string,
  description?: string,
  kind: NotifyKind = "info",
): void {
  // Collapse duplicate callbacks (including StrictMode effects) without hiding retries.
  const key = JSON.stringify([kind, title, description]);
  const now = Date.now();
  for (const [message, at] of recentNotifications) {
    if (now - at >= 1500) recentNotifications.delete(message);
  }
  if (recentNotifications.has(key)) return;
  recentNotifications.set(key, now);
  const options = { description, timeout: kind === "error" || kind === "warning" ? 10000 : 5000 };
  switch (kind) {
    case "success":
      Toast.toast.success(title, options);
      break;
    case "error":
      Toast.toast.danger(title, options);
      break;
    case "warning":
      Toast.toast.warning(title, options);
      break;
    case "info":
    default:
      Toast.toast.info(title, options);
      break;
  }
}
