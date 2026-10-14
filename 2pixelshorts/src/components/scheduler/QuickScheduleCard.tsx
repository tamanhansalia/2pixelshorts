import React, { useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  FolderOpen,
  Sparkles,
} from "lucide-react";
import { Alert, ListBox, Select, Spinner } from "@heroui/react";
import type {
  ScheduleItem,
  SocialPublishPayload,
  TranscriptionStatus,
} from "../../types";
import {
  buildQuickSchedulePayload,
  DEFAULT_RELEASE_TIME,
  DEFAULT_TIMEZONE,
  quickScheduleBlocker,
} from "../../lib/outbox";
import { TIMEZONES } from "../social/SocialPublisher";
import { Button } from "../ui/Button";
import { SectionCard } from "../ui/Card";
import { Field, TextArea, TextInput } from "../ui/Field";
import { LinearProgress } from "../ui/LinearProgress";

export interface QuickSeo {
  title: string;
  description: string;
  tags: string[];
}

interface QuickScheduleCardProps {
  onPickVideo: () => Promise<string | null>;
  onAnalyzeVideo: (videoPath: string) => Promise<QuickSeo>;
  onQueueShort: (payload: SocialPublishPayload) => ScheduleItem;
  /** Engine readiness; warns before a doomed Analyze run when known. */
  transcription?: TranscriptionStatus | null;
}

/**
 * Schedule a finished video straight from the Queue page: pick the file,
 * generate its SEO package with one click, tweak, and queue it for
 * release. Channels are picked later (Queue → Edit), like every other
 * locally queued entry.
 */
export const QuickScheduleCard: React.FC<QuickScheduleCardProps> = ({
  onPickVideo,
  onAnalyzeVideo,
  onQueueShort,
  transcription,
}) => {
  const [videoPath, setVideoPath] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState(DEFAULT_RELEASE_TIME);
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBrowse = async () => {
    const picked = await onPickVideo();
    if (picked) {
      setVideoPath(picked);
      setError(null);
    }
  };

  const handleAnalyze = async () => {
    const path = videoPath.trim();
    if (!path || isAnalyzing) return;
    setIsAnalyzing(true);
    setError(null);
    try {
      const seo = await onAnalyzeVideo(path);
      setTitle(seo.title);
      setDescription(seo.description);
      setTagsText(seo.tags.join(", "));
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Analysis failed — try again.",
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  const blocker = quickScheduleBlocker({
    videoPath,
    title,
    description,
    tagsText,
    scheduledDate,
    scheduledTime,
    timezone,
  });

  const handleSchedule = () => {
    if (blocker) {
      setError(blocker);
      return;
    }
    onQueueShort(
      buildQuickSchedulePayload({
        videoPath,
        title,
        description,
        tagsText,
        scheduledDate,
        scheduledTime,
        timezone,
      }),
    );
    setVideoPath("");
    setTitle("");
    setDescription("");
    setTagsText("");
    setError(null);
  };

  const tagCount = tagsText.trim()
    ? tagsText.split(",").filter((p) => p.trim()).length
    : 0;

  return (
    <SectionCard
      title="Add a video"
      description="Pick a finished short, generate SEO, schedule it"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-xs leading-snug text-muted">
            Pick channels later via Edit.
          </span>
          <Button
            variant="primary"
            icon={<CalendarClock />}
            disabled={blocker !== null}
            onClick={handleSchedule}
            title={blocker ?? "Queue this short for scheduled release"}
          >
            Schedule
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Video file">
          <div className="flex items-center gap-1.5">
            <TextInput
              value={videoPath}
              onChange={(e) => setVideoPath(e.target.value)}
              placeholder="final_short.mp4"
              className="font-mono text-sm"
              aria-label="Video file to schedule"
              disabled={isAnalyzing}
            />
            <Button
              variant="secondary"
              className="shrink-0"
              iconOnly
              icon={<FolderOpen />}
              onClick={handleBrowse}
              disabled={isAnalyzing}
              aria-label="Browse for a video file"
              title="Browse for a video file"
            />
          </div>
        </Field>

        <div className="space-y-2">
          <Button
            variant="secondary"
            fullWidth
            icon={<Sparkles />}
            isLoading={isAnalyzing}
            disabled={!videoPath.trim() || isAnalyzing}
            onClick={handleAnalyze}
            title={
              !videoPath.trim() ? "Pick a video file first" : "Analyze this video"
            }
          >
            {isAnalyzing ? "Analyzing…" : "Generate title & tags"}
          </Button>

          {isAnalyzing && (
            <div className="space-y-1.5">
              <LinearProgress label="Analyzing video" />
              <p className="flex items-center gap-1.5 text-xs text-muted">
                <Spinner size="sm" color="current" className="size-3" />
                Transcribing and writing SEO — long videos take a while.
              </p>
            </div>
          )}

          {transcription && transcription.active_engine === "none" && (
            <p className="text-xs leading-snug text-warning">
              No transcription engine is set up, so analysis will fail. Add an
              ElevenLabs key (Settings → API keys) or install local
              transcription (Settings → Engine).
            </p>
          )}
        </div>

        <Field
          label="Title"
          action={
            <span className="tabular-nums text-xs text-muted">{title.length}/100</span>
          }
        >
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Generate, or type a title"
            aria-label="Post title"
          />
        </Field>

        <Field label="Description">
          <TextArea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Caption and description"
            aria-label="Description and caption"
          />
        </Field>

        <Field
          label="Tags"
          hint="Comma-separated"
          action={<span className="tabular-nums text-xs text-muted">{tagCount}</span>}
        >
          <TextInput
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="rust, shorts, coding"
            aria-label="Search tags"
          />
        </Field>

        <div className="grid grid-cols-2 items-end gap-2">
          <Field label="Date">
            <TextInput
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
              aria-label="Release date"
            />
          </Field>
          <Field label="Time">
            <TextInput
              type="time"
              value={scheduledTime}
              onChange={(e) => setScheduledTime(e.target.value)}
              aria-label="Release time"
            />
          </Field>
        </div>
        <Field label="Timezone">
          <Select
            variant="secondary"
            selectedKey={timezone}
            onSelectionChange={(key) => setTimezone(String(key))}
            aria-label="Timezone"
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {TIMEZONES.map((tz) => (
                  <ListBox.Item key={tz.id} id={tz.id} textValue={tz.label}>
                    {tz.label}
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </Field>

        {error && (
          <Alert status="danger">
            <Alert.Indicator>
              <AlertCircle className="size-4" />
            </Alert.Indicator>
            <Alert.Content>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </div>
    </SectionCard>
  );
};
