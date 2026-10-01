import React, { useState } from "react";
import { 
  CalendarClock, 
  Clock, 
  Trash2, 
  Film, 
  Plus
} from "lucide-react";
import { ScheduleItem } from "../../types";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Modal } from "../ui/Modal";

interface ScheduleQueueProps {
  queue: ScheduleItem[];
  onCancelJob: (id: string) => void;
  onNavigateToStudio: () => void;
}

export const ScheduleQueue: React.FC<ScheduleQueueProps> = ({
  queue,
  onCancelJob,
  onNavigateToStudio,
}) => {
  const [jobToCancel, setJobToCancel] = useState<ScheduleItem | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  const displayQueue = queue;

  const confirmCancel = async () => {
    if (!jobToCancel) return;
    setCancelingId(jobToCancel.id);
    await new Promise((r) => setTimeout(r, 120));
    onCancelJob(jobToCancel.id);
    setCancelingId(null);
    setJobToCancel(null);
  };

  return (
    <div className="space-y-4 max-w-6xl mx-auto select-none font-sans">
      {/* Top Header Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-surface border border-border">
        <div className="flex items-center gap-2.5">
          <div className="h-6 w-6 rounded bg-surface-secondary border border-border flex items-center justify-center text-foreground shrink-0">
            <CalendarClock className="w-3.5 h-3.5" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground tracking-tight">
              Queue
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface-secondary text-muted border border-border">
              {displayQueue.length} jobs
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button
            variant="primary"
            size="xs"
            icon={<Plus className="w-3 h-3" />}
            onClick={onNavigateToStudio}
          >
            Create New Short
          </Button>
        </div>
      </div>

      {displayQueue.length === 0 ? (
        <div className="p-16 text-center rounded-lg bg-surface border border-border space-y-3">
          <div className="h-10 w-10 rounded-md bg-surface-secondary border border-border flex items-center justify-center mx-auto text-muted">
            <CalendarClock className="w-5 h-5 text-foreground" />
          </div>
          <div className="space-y-1">
            <h2 className="text-xs font-semibold text-foreground">No Scheduled Jobs in Queue</h2>
            <p className="text-[11px] text-muted max-w-xs mx-auto">
              Your dispatch queue is empty. Render a short in the Studio and select a scheduled release date.
            </p>
          </div>
          <Button
            variant="secondary"
            size="xs"
            onClick={onNavigateToStudio}
          >
            Open Studio Canvas →
          </Button>
        </div>
      ) : (
        /* Desktop Data Table */
        <div className="rounded-lg bg-surface border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-secondary/70 border-b border-border text-[10px] text-muted font-mono uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-4">Post & Media File</th>
                  <th className="py-2.5 px-4">Target Channels</th>
                  <th className="py-2.5 px-4">Scheduled Release</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {displayQueue.map((item) => {
                  const isCanceling = cancelingId === item.id;
                  const dateFormatted = new Date(item.scheduled_for).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  });

                  return (
                    <tr
                      key={item.id}
                      className="hover:bg-surface-secondary/40 transition-colors"
                    >
                      {/* Media Title & File */}
                      <td className="py-3 px-4 max-w-xs">
                        <div className="flex items-center gap-2.5">
                          <div className="h-7 w-7 rounded bg-surface-secondary border border-border flex items-center justify-center text-foreground shrink-0">
                            <Film className="w-3.5 h-3.5" />
                          </div>
                          <div className="overflow-hidden min-w-0">
                            <div className="font-semibold text-foreground text-xs truncate" title={item.title}>
                              {item.title}
                            </div>
                            <div className="text-[10px] font-mono text-muted truncate max-w-[220px]" title={item.video_path}>
                              {item.video_path}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Platforms */}
                      <td className="py-3 px-4">
                        <div className="flex flex-wrap items-center gap-1">
                          {item.platforms.map((p) => (
                            <Badge key={p} variant="default" size="xs">
                              {p}
                            </Badge>
                          ))}
                        </div>
                      </td>

                      {/* Scheduled Time */}
                      <td className="py-3 px-4 text-xs whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-foreground">
                          <Clock className="w-3 h-3 text-muted" />
                          <span className="font-medium text-[11px]">{dateFormatted}</span>
                          <span className="text-[10px] text-muted font-mono">({item.timezone})</span>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        {item.status === "queued" && (
                          <Badge variant="default" size="xs" dot>Queued</Badge>
                        )}
                        {item.status === "publishing" && (
                          <Badge variant="neutral" size="xs" dot>Dispatching</Badge>
                        )}
                        {item.status === "completed" && (
                          <Badge variant="success" size="xs" dot>Completed</Badge>
                        )}
                        {item.status === "failed" && (
                          <Badge variant="danger" size="xs" dot>Failed</Badge>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="xs"
                          isLoading={isCanceling}
                          icon={!isCanceling ? <Trash2 className="w-3 h-3 text-muted hover:text-danger" /> : undefined}
                          onClick={() => setJobToCancel(item)}
                        >
                          Cancel
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      <Modal
        isOpen={!!jobToCancel}
        onClose={() => setJobToCancel(null)}
        title="Cancel Scheduled Dispatch"
        description="Are you sure you want to remove this publication job from the schedule queue?"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setJobToCancel(null)}
            >
              Keep in Queue
            </Button>
            <Button
              variant="danger"
              size="sm"
              isLoading={!!cancelingId}
              onClick={confirmCancel}
            >
              Confirm Cancellation
            </Button>
          </>
        }
      >
        {jobToCancel && (
          <div className="p-3.5 rounded-md bg-surface-secondary border border-border space-y-1.5 text-xs">
            <div className="font-semibold text-foreground">{jobToCancel.title}</div>
            <div className="text-[10px] font-mono text-muted truncate">{jobToCancel.video_path}</div>
            <div className="text-[11px] text-muted">
              Scheduled for: {new Date(jobToCancel.scheduled_for).toLocaleString()}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
