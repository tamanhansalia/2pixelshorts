import { STUDIO_STAGES, type StudioStage } from "../../lib/studioWorkflow";

interface Props {
  active: StudioStage;
  hasVideo: boolean;
  hasJobs: boolean;
  onChange: (stage: StudioStage) => void;
}

export function StudioNavigation({ active, hasVideo, hasJobs, onChange }: Props) {
  return (
    <nav aria-label="Studio stages" className="studio-navigation">
      <ol className="grid min-w-[480px] grid-cols-5 gap-1">
        {STUDIO_STAGES.map((stage, index) => (
          <li key={stage.id} className="min-w-0">
            <button
              type="button"
              aria-current={active === stage.id ? "step" : undefined}
              aria-controls={`studio-${stage.id}`}
              disabled={stage.id !== "source" && !hasVideo && !(stage.id === "render" && hasJobs)}
              onClick={() => onChange(stage.id)}
              className="studio-stage-button"
            >
              <span className="studio-stage-number" aria-hidden="true">{index + 1}</span>
              <span className="truncate">{stage.label}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
