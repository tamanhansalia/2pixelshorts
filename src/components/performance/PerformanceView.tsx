import React, { useMemo } from "react";
import { BarChart3, Clock, ExternalLink, RefreshCw, Sparkles } from "lucide-react";
import { PageHeader } from "../layout/PageHeader";
import { SectionCard } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import {
  MIN_POSTS_FOR_MEDIAN,
  WINNER_MULTIPLE,
  bestPostingHours,
  rankPosts,
  winningTitles,
  type PerformanceRecords,
} from "../../lib/performance";
import { openExternalUrl } from "../../lib/ipc";

interface PerformanceViewProps {
  records: PerformanceRecords;
  refreshing: boolean;
  onRefresh: () => void;
  hasZernioKey: boolean;
  onOpenSettings: () => void;
  onOpenQueue: () => void;
}

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function hourLabel(hour: number): string {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric" });
}

/**
 * Post performance: how each published short did against the channel's
 * own median, which titles won (they steer every new SEO run), and which
 * posting hours draw the most views.
 */
export const PerformanceView: React.FC<PerformanceViewProps> = ({
  records,
  refreshing,
  onRefresh,
  hasZernioKey,
  onOpenSettings,
  onOpenQueue,
}) => {
  const { median, ranked } = useMemo(() => rankPosts(records), [records]);
  const winners = useMemo(() => winningTitles(records), [records]);
  const hours = useMemo(() => bestPostingHours(records).slice(0, 3), [records]);
  const tracked = Object.keys(records).length;
  const pending = Object.values(records).filter((r) => r.pending).length;
  const totalViews = ranked.reduce((sum, r) => sum + r.views, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Performance"
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              <span className="font-medium text-foreground">{tracked}</span>{" "}
              published {tracked === 1 ? "post" : "posts"}
            </span>
            {ranked.length > 0 && (
              <span className="tabular-nums">
                {compact.format(totalViews)} views total
              </span>
            )}
            {median > 0 && (
              <span className="tabular-nums">
                median {compact.format(median)} per post
              </span>
            )}
            {pending > 0 && <span>{pending} syncing</span>}
          </span>
        }
        actions={
          hasZernioKey && tracked > 0 ? (
            <Button
              variant="secondary"
              icon={<RefreshCw />}
              isLoading={refreshing}
              disabled={refreshing}
              onClick={onRefresh}
            >
              {refreshing ? "Refreshing" : "Refresh"}
            </Button>
          ) : undefined
        }
      />

      {!hasZernioKey ? (
        <SectionCard title="Post performance">
          <EmptyState
            icon={<BarChart3 />}
            title="Connect Zernio to see results"
            description="Views, likes and comments come from your Zernio account. Add the API key, then publish a short."
            action={
              <Button variant="secondary" onClick={onOpenSettings}>
                Open API keys
              </Button>
            }
          />
        </SectionCard>
      ) : tracked === 0 ? (
        <SectionCard title="Post performance">
          <EmptyState
            icon={<BarChart3 />}
            title="Nothing published yet"
            description="Shorts you publish through the Queue show up here with their views, so the SEO can learn what works on your channel."
            action={
              <Button variant="secondary" onClick={onOpenQueue}>
                Open Queue
              </Button>
            }
          />
        </SectionCard>
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <SectionCard
            title="Shorts by views"
            description={
              median > 0
                ? `Each post is compared with your channel median (${compact.format(median)} views)`
                : `Comparisons start once ${MIN_POSTS_FOR_MEDIAN} posts have metrics`
            }
            contentClassName="p-0"
          >
            {ranked.length === 0 ? (
              <EmptyState
                compact
                icon={<RefreshCw />}
                title="Waiting for metrics"
                description="Zernio syncs numbers a little after a post goes live. Refresh in a while."
              />
            ) : (
              <ul className="divide-y divide-separator">
                {ranked.map(({ record, views, multiple }) => {
                  const m = record.metrics!;
                  return (
                    <li
                      key={record.postId}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1 basis-56">
                        <p className="truncate text-sm font-medium text-foreground">
                          {record.title || "Untitled short"}
                        </p>
                        <p className="text-xs text-muted">
                          {new Date(record.publishedAt).toLocaleDateString()} ·{" "}
                          {record.platforms.join(", ") || "—"}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted tabular-nums">
                        <span>
                          <span className="font-medium text-foreground">
                            {compact.format(views)}
                          </span>{" "}
                          views
                        </span>
                        <span>{compact.format(m.likes)} likes</span>
                        <span>{compact.format(m.comments)} comments</span>
                        {multiple !== null && (
                          <Badge
                            variant={
                              multiple >= WINNER_MULTIPLE
                                ? "success"
                                : multiple < 0.5
                                  ? "warning"
                                  : "neutral"
                            }
                          >
                            {multiple}× median
                          </Badge>
                        )}
                        {m.url && (
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            icon={<ExternalLink />}
                            aria-label="Open post"
                            onClick={() => void openExternalUrl(m.url!)}
                          />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>

          <div className="min-w-0 space-y-5">
            <SectionCard
              title="What's working"
              icon={<Sparkles className="size-4" />}
              description={`Titles at ${WINNER_MULTIPLE}× your median or better. New SEO runs copy their style.`}
            >
              {winners.length > 0 ? (
                <ol className="list-decimal space-y-1.5 pl-4 text-sm text-foreground">
                  {winners.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs leading-snug text-muted">
                  No clear winners yet. A short needs at least{" "}
                  {WINNER_MULTIPLE}× the median of {MIN_POSTS_FOR_MEDIAN}+
                  measured posts.
                </p>
              )}
            </SectionCard>

            <SectionCard
              title="Best posting hours"
              icon={<Clock className="size-4" />}
              description="Your local time, by median views (2+ posts per hour)"
            >
              {hours.length > 0 ? (
                <ul className="space-y-1.5 text-sm">
                  {hours.map((h) => (
                    <li
                      key={h.hour}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="text-foreground">{hourLabel(h.hour)}</span>
                      <span className="text-xs text-muted tabular-nums">
                        {compact.format(h.medianViews)} median · {h.posts} posts
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs leading-snug text-muted">
                  Post at a few different times. Hours show up once two
                  posts share one.
                </p>
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </div>
  );
};
