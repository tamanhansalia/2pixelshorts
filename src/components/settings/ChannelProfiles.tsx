import React, { useEffect, useRef, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { SectionCard } from "../ui/Card";
import { Field, TextArea, TextInput } from "../ui/Field";
import type { ChannelProfile } from "../../lib/channelProfiles";

interface ChannelProfilesProps {
  profiles: ChannelProfile[];
  defaultId: string | null;
  onSave: (profiles: ChannelProfile[], defaultId: string | null) => void;
}

function blankProfile(): ChannelProfile {
  return {
    id: `channel-${crypto.randomUUID()}`,
    name: "",
    niche: "",
    audience: "",
    tone: "",
    cta: "",
    keywords: [],
  };
}

/**
 * Global channel context profiles. The default profile steers every agent
 * cut and SEO suggestion unless a per-video override is set in the Studio.
 */
export const ChannelProfiles: React.FC<ChannelProfilesProps> = ({
  profiles,
  defaultId,
  onSave,
}) => {
  const pendingProfileId = useRef<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>(
    () => defaultId ?? profiles[0]?.id ?? "",
  );
  const [draft, setDraft] = useState<ChannelProfile>(
    () => profiles.find((p) => p.id === (defaultId ?? profiles[0]?.id)) ?? blankProfile(),
  );
  const [keywordsInput, setKeywordsInput] = useState(
    () => draft.keywords.join(", "),
  );

  // Resync the editor when the selection or the saved list changes.
  useEffect(() => {
    // A new draft is intentionally absent from the saved list. Do not
    // replace it with the first saved profile when Add changes selection.
    if (pendingProfileId.current === selectedId && !profiles.some((p) => p.id === selectedId)) return;
    const current =
      profiles.find((p) => p.id === selectedId) ??
      profiles[0] ??
      blankProfile();
    setDraft({ ...current, keywords: [...current.keywords] });
    setKeywordsInput(current.keywords.join(", "));
    if (!profiles.some((p) => p.id === selectedId) && profiles[0]) {
      setSelectedId(profiles[0].id);
    }
    if (profiles.some((p) => p.id === pendingProfileId.current)) pendingProfileId.current = null;
  }, [selectedId, profiles]);

  const set = (patch: Partial<ChannelProfile>) =>
    setDraft((prev) => ({ ...prev, ...patch }));

  const handleSave = () => {
    const keywords = keywordsInput
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    const saved: ChannelProfile = {
      ...draft,
      name: draft.name.trim() || "Untitled channel",
      keywords,
    };
    const exists = profiles.some((p) => p.id === saved.id);
    const next = exists
      ? profiles.map((p) => (p.id === saved.id ? saved : p))
      : [...profiles, saved];
    onSave(next, defaultId ?? profiles[0]?.id ?? saved.id);
  };

  const handleAdd = () => {
    const fresh = blankProfile();
    pendingProfileId.current = fresh.id;
    setSelectedId(fresh.id);
    setDraft(fresh);
    setKeywordsInput("");
  };

  const handleDelete = (id: string) => {
    if (profiles.length <= 1) return;
    const next = profiles.filter((p) => p.id !== id);
    const nextDefault =
      defaultId === id ? (next[0]?.id ?? null) : defaultId;
    if (selectedId === id) setSelectedId(next[0]?.id ?? "");
    onSave(next, nextDefault);
  };

  const dirty =
    JSON.stringify({ ...draft, keywords: keywordsInput }) !==
    JSON.stringify({
      ...(profiles.find((p) => p.id === draft.id) ?? blankProfile()),
      keywords: (profiles.find((p) => p.id === draft.id)?.keywords ?? []).join(", "),
    });

  const effectiveDefault = defaultId ?? profiles[0]?.id;
  const isNew = !profiles.some((p) => p.id === draft.id);

  return (
    <div className="@container max-w-5xl">
    {/* Container breakpoints: the settings column is far narrower than the
        window, so viewport md/lg would squeeze the editor. */}
    <div className="grid items-start gap-5 @3xl:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="overflow-hidden rounded-3xl bg-surface shadow-surface">
        <div className="flex h-10 items-center justify-between border-b border-separator pr-1.5 pl-3">
          <span className="text-xs font-semibold text-foreground">
            Profiles
          </span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Plus />}
            onClick={handleAdd}
            aria-label="New channel profile"
            title="New channel profile"
          />
        </div>
        <ul className="p-1">
          {profiles.map((profile) => {
            const isDefault = profile.id === effectiveDefault;
            const isSelected = profile.id === selectedId;
            return (
              <li key={profile.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(profile.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setSelectedId(profile.id);
                  }}
                  className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${
                    isSelected
                      ? "bg-surface-tertiary"
                      : "hover:bg-surface-secondary"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {profile.name || "Untitled channel"}
                      </span>
                      {isDefault && <Badge variant="accent">Default</Badge>}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {profile.niche || "No niche set"}
                    </div>
                  </div>
                  {profiles.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon={<Trash2 />}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(profile.id);
                      }}
                      aria-label={`Delete ${profile.name}`}
                      title="Delete profile"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    />
                  )}
                </div>
              </li>
            );
          })}
          {isNew && (
            <li className="rounded-md bg-surface-tertiary px-2 py-1.5 text-sm font-medium text-foreground">
              {draft.name || "New channel"}
              <div className="text-xs font-normal text-muted">Unsaved</div>
            </li>
          )}
        </ul>
      </div>

      <SectionCard
        title={draft.name || (isNew ? "New channel" : "Untitled channel")}
        description="Niche, audience, tone and CTA used for cuts and SEO"
        actions={
          !isNew && draft.id !== effectiveDefault ? (
            <Button variant="ghost" onClick={() => onSave(profiles, draft.id)}>
              Set as default
            </Button>
          ) : undefined
        }
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted">
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <Button
              variant="primary"
              icon={<Check />}
              onClick={handleSave}
              disabled={!dirty}
            >
              Save channel
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="Channel name">
              <TextInput
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="e.g. 2PixelSpace"
                aria-label="Channel name"
              />
            </Field>
            <Field label="Call to action">
              <TextInput
                value={draft.cta}
                onChange={(e) => set({ cta: e.target.value })}
                placeholder="e.g. Subscribe for daily guides!"
                aria-label="Call to action"
              />
            </Field>
          </div>
          <Field label="Niche">
            <TextArea
              rows={3}
              value={draft.niche}
              onChange={(e) => set({ niche: e.target.value })}
              placeholder="What the channel is about…"
              aria-label="Channel niche"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
            <Field label="Audience">
              <TextInput
                value={draft.audience}
                onChange={(e) => set({ audience: e.target.value })}
                placeholder="e.g. developers, founders…"
                aria-label="Target audience"
              />
            </Field>
            <Field label="Tone">
              <TextInput
                value={draft.tone}
                onChange={(e) => set({ tone: e.target.value })}
                placeholder="e.g. punchy and practical"
                aria-label="Content tone"
              />
            </Field>
          </div>
          <Field label="Keywords" hint="Comma-separated">
            <TextInput
              value={keywordsInput}
              onChange={(e) => setKeywordsInput(e.target.value)}
              placeholder="e.g. ai tools, rust, saas"
              aria-label="Channel keywords"
            />
          </Field>
        </div>
      </SectionCard>
    </div>
    </div>
  );
};
