import { Toast } from "@heroui/react";

/**
 * App-wide notifications, built on HeroUI v3's toast queue.
 * Pair with <AppToasts /> (mounted once in App) which renders Toast.Provider.
 */
export type NotifyKind = "success" | "error" | "info" | "warning";

export function notify(
  title: string,
  description?: string,
  kind: NotifyKind = "info",
): void {
  const options = description ? { description } : undefined;
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
