import React from "react";
import { Toast } from "@heroui/react";

/** Mount once at the app root. Notifications are fired via `notify()` in lib. */
export const AppToasts: React.FC = () => {
  return <Toast.Provider placement="bottom end" maxVisibleToasts={4} />;
};
