import { notify } from "../../lib/notify";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, HardDrive, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { SectionCard } from "../ui/Card";
import { isTauri, openFileLocation } from "../../lib/ipc";
import {
  deleteStorageItems,
  formatBytes,
  scanStorage,
  STORAGE_CATEGORIES,
  type StorageDeleteReport,
  type StorageItem,
  type StorageKind,
  type StorageScope,
} from "../../lib/storage";

interface StorageSettingsProps {
  scope: StorageScope;
  onCleaned: (report: StorageDeleteReport) => void;
  onTriggerToast?: (title: string, description?: string, type?: "success" | "error" | "info" | "warning") => void;
}

const VISIBLE_ROWS = 8;

function splitPath(path: string): { name: string; folder: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { name: path.slice(cut + 1), folder: cut > 0 ? path.slice(0, cut) : "" };
}

function itemLabel(item: StorageItem): { name: string; detail: string } {
  const { name, folder } = splitPath(item.path);
  if (item.kind === "cache") return { name: `${item.files.length} saved lookup${item.files.length === 1 ? "" : "s"}`, detail: item.path };
  if (item.kind === "analysis") return { name: `${name} (video deleted)`, detail: folder };
  return { name, detail: folder };
}

function formatDate(ms: number | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Settings > Storage: app-made files by category, moved to the Trash on confirm. */
export const StorageSettings: React.FC<StorageSettingsProps> = ({ scope, onCleaned, onTriggerToast }) => {
  const [items, setItems] = useState<StorageItem[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanVersion = useRef(0);
  const [isScanning, setIsScanning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<StorageKind>>(() => new Set());
  const [confirming, setConfirming] = useState<{ kind: StorageKind; paths: string[] } | null>(null);
  const [deletingKind, setDeletingKind] = useState<StorageKind | null>(null);
  // Records change on every render tick; scans use the latest scope without re-running.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    const version = ++scanVersion.current;
    setIsScanning(true);
    setScanError(null);
    try {
      const next = await scanStorage(scopeRef.current);
      if (version !== scanVersion.current) return;
      setItems(next);
      const live = new Set(next.filter((i) => !i.protected).map((i) => i.path));
      setSelected((prev) => new Set([...prev].filter((p) => live.has(p))));
    } catch (error) {
      if (version !== scanVersion.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setScanError(message);
      setItems(null);
      notify("Storage scan failed", message, "error");
    } finally {
      if (version === scanVersion.current) setIsScanning(false);
    }
  }, []);

  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    void refresh();
  }, [refresh, scopeKey]);

  const byKind = useMemo(() => {
    const map = new Map<StorageKind, StorageItem[]>();
    for (const item of items ?? []) map.set(item.kind, [...(map.get(item.kind) ?? []), item]);
    return map;
  }, [items]);

  const totalBytes = (items ?? []).reduce((sum, item) => sum + item.bytes, 0);
  const sizeOf = (paths: string[]) =>
    (items ?? []).filter((i) => paths.includes(i.path)).reduce((sum, i) => sum + i.bytes, 0);

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const runDelete = async (kind: StorageKind, paths: string[]) => {
    setDeletingKind(kind);
    try {
      const report = await deleteStorageItems(scopeRef.current, paths);
      onCleaned(report);
      if (report.removed.length > 0) {
        onTriggerToast?.(
          `Moved ${report.removed.length} item${report.removed.length === 1 ? "" : "s"} to Trash`,
          `${formatBytes(report.bytes)} moved. Empty the Trash to reclaim disk space.`,
          "success",
        );
      }
      if (report.failed.length > 0) {
        onTriggerToast?.(
          `${report.failed.length} item${report.failed.length === 1 ? "" : "s"} not removed`,
          report.failed[0].error,
          "error",
        );
      }
    } catch (error) {
      onTriggerToast?.("Cleanup failed", error instanceof Error ? error.message : undefined, "error");
    } finally {
      setDeletingKind(null);
      setConfirming(null);
      await refresh();
    }
  };

  if (!isTauri()) {
    return (
      <div className="max-w-3xl">
        <SectionCard title="Storage" description="Open the desktop app to see and clean up files on this computer.">
          <p className="text-xs text-muted">The browser preview cannot read local files.</p>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-5">
      <SectionCard
        title={items ? `${formatBytes(totalBytes)} of app files` : isScanning ? "Scanning…" : "App files"}
        description="Only files 2pixelshorts created are listed. Recordings you imported are never deleted. Removed items go to the Trash, so you can restore them."
        icon={<HardDrive />}
        actions={
          <Button variant="ghost" icon={<RefreshCw />} isLoading={isScanning} onClick={() => void refresh()}>
            Rescan
          </Button>
        }
      >
        
          <p className="text-xs leading-relaxed text-muted">
            Files in use by a render or a post waiting to publish are shown but can’t be removed until they finish.
          </p>
      </SectionCard>

      {scanError && <p role="alert" className="text-sm text-danger">Storage scan failed: {scanError}. Try Rescan.</p>}

      {STORAGE_CATEGORIES.map(({ kind, label, description }) => {
        const list = byKind.get(kind) ?? [];
        const removable = list.filter((i) => !i.protected);
        const picked = removable.filter((i) => selected.has(i.path)).map((i) => i.path);
        const target = picked.length > 0 ? picked : removable.map((i) => i.path);
        const bytes = list.reduce((sum, i) => sum + i.bytes, 0);
        const isOpen = expanded.has(kind);
        const rows = isOpen ? list : list.slice(0, VISIBLE_ROWS);
        const isConfirming = confirming?.kind === kind;

        return (
          <SectionCard
            key={kind}
            title={label}
            description={description}
            contentClassName="p-0"
            actions={
              list.length > 0 && <Badge variant="neutral">{formatBytes(bytes)}</Badge>
            }
            footer={
              removable.length > 0 && (
                <div className="flex w-full flex-wrap items-center justify-end gap-2">
                  {isConfirming ? (
                    <>
                      <span className="mr-auto text-xs text-muted">
                        Move {confirming.paths.length} item{confirming.paths.length === 1 ? "" : "s"} ({formatBytes(sizeOf(confirming.paths))}) to the Trash?
                      </span>
                      <Button variant="ghost" onClick={() => setConfirming(null)} disabled={deletingKind !== null}>
                        Cancel
                      </Button>
                      <Button
                        variant="danger"
                        icon={<Trash2 />}
                        isLoading={deletingKind === kind}
                        onClick={() => void runDelete(kind, confirming.paths)}
                      >
                        Move to Trash
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="danger-soft"
                      icon={<Trash2 />}
                      disabled={deletingKind !== null}
                      onClick={() => setConfirming({ kind, paths: target })}
                    >
                      {picked.length > 0
                        ? `Remove ${picked.length} selected`
                        : removable.length === 1 ? "Remove" : `Remove all ${removable.length}`}
                    </Button>
                  )}
                </div>
              )
            }
          >
            {list.length === 0 ? (
              <p className="pb-1 text-xs text-muted">{scanError ? "Could not check these files." : items ? "Nothing to clean up." : "Scanning…"}</p>
            ) : (
              <>
                <ul className="divide-y divide-separator">
                  {rows.map((item) => {
                    const { name, detail } = itemLabel(item);
                    return (
                      <li key={item.path} className="flex min-w-0 items-center gap-3 py-2.5">
                        <input
                          type="checkbox"
                          className="disabled:cursor-not-allowed disabled:opacity-35"
                          aria-label={`Select ${name}`}
                          checked={selected.has(item.path)}
                          disabled={item.protected || deletingKind !== null}
                          onChange={() => toggle(item.path)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-foreground" title={item.path}>{name}</div>
                          <div className="truncate text-xs text-muted" title={detail}>
                            {[formatBytes(item.bytes), formatDate(item.modified_ms), detail].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        {item.protected && <Badge variant="warning">In use</Badge>}
                        {item.kind !== "analysis" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            icon={<FolderOpen />}
                            aria-label={`Show ${name} in folder`}
                            title="Show in folder"
                            onClick={() => void openFileLocation(item.path).catch(() => {})}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
                {list.length > VISIBLE_ROWS && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mb-1"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (isOpen) next.delete(kind);
                        else next.add(kind);
                        return next;
                      })
                    }
                  >
                    {isOpen ? "Show fewer" : `Show all ${list.length}`}
                  </Button>
                )}
              </>
            )}
          </SectionCard>
        );
      })}
    </div>
  );
};
