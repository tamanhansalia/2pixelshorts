import React from "react";
import { Clapperboard } from "lucide-react";
import type { RenderHistoryEntry } from "../../lib/renderHistory";
import { Modal } from "../ui/Modal";
import { RenderJobsPanel } from "./RenderJobsPanel";

interface RenderJobsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  jobs: RenderHistoryEntry[];
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onClearFinished: () => void;
  onOpenFileLocation: (path: string) => void;
  onOpenFile: (path: string) => void;
  onQueueOutput?: (outputPath: string) => void;
}

/** Global render-job center: visible from any tab while renders run. */
export const RenderJobsDrawer: React.FC<RenderJobsDrawerProps> = ({
  isOpen,
  onClose,
  jobs,
  onCancel,
  onDismiss,
  onClearFinished,
  onOpenFileLocation,
  onOpenFile,
  onQueueOutput,
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      icon={<Clapperboard className="size-4" />}
      title="Render jobs"
      description="Running renders and recent history. Renders keep going when you switch pages."
    >
      <RenderJobsPanel
        jobs={jobs}
        onCancel={onCancel}
        onDismiss={onDismiss}
        onClearFinished={onClearFinished}
        onOpenFileLocation={onOpenFileLocation}
        onOpenFile={onOpenFile}
        onQueueOutput={onQueueOutput}
      />
    </Modal>
  );
};
