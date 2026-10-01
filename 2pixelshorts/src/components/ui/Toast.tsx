import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, AlertCircle, Info, X } from "lucide-react";

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  type: "success" | "error" | "info";
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none font-sans">
      <AnimatePresence>
        {toasts.map((toast) => {
          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 500, damping: 36 }}
              className="pointer-events-auto p-3 rounded-md bg-surface border border-border shadow-lg text-xs flex items-start gap-2.5 text-foreground select-none"
            >
              <div className="mt-0.5 shrink-0">
                {toast.type === "success" && (
                  <div className="h-4 w-4 rounded bg-success/20 text-success border border-success/30 flex items-center justify-center">
                    <Check className="w-2.5 h-2.5 stroke-[3]" />
                  </div>
                )}
                {toast.type === "error" && (
                  <div className="h-4 w-4 rounded bg-danger/20 text-danger border border-danger/30 flex items-center justify-center">
                    <AlertCircle className="w-2.5 h-2.5 stroke-[2.5]" />
                  </div>
                )}
                {toast.type === "info" && (
                  <div className="h-4 w-4 rounded bg-surface-secondary border border-border text-muted flex items-center justify-center">
                    <Info className="w-2.5 h-2.5" />
                  </div>
                )}
              </div>

              <div className="flex-1 space-y-0.5 overflow-hidden">
                <div className="text-foreground font-semibold text-xs tracking-tight truncate">
                  {toast.title}
                </div>
                {toast.description && (
                  <div className="text-[11px] text-muted line-clamp-2 leading-relaxed">
                    {toast.description}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                className="text-muted hover:text-foreground p-0.5 transition shrink-0 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};
