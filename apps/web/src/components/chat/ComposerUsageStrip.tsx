import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatResetsIn } from "@t3tools/shared/usageLimits";
import { useState } from "react";

import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  contextTone,
  statuslinePace,
  stripWindows,
  type UsageTone,
} from "./ComposerUsageStrip.logic";

const TONE_TEXT: Record<UsageTone, string> = {
  ok: "text-emerald-700 dark:text-emerald-300",
  warn: "text-amber-700 dark:text-amber-200",
  critical: "text-rose-700 dark:text-rose-300",
  early: "text-sky-700 dark:text-sky-300",
};

const TONE_FILL: Record<UsageTone, string> = {
  ok: "bg-emerald-600 dark:bg-emerald-300",
  warn: "bg-amber-500 dark:bg-amber-200",
  critical: "bg-rose-600 dark:bg-rose-300",
  early: "bg-sky-600 dark:bg-sky-300",
};

const SHORT_LABEL: Partial<Record<ServerProviderUsageWindow["kind"], string>> = {
  session: "5h",
  weekly: "7d",
};

function UsageBar({ percent, tone }: { readonly percent: number; readonly tone: UsageTone }) {
  return (
    <span className="inline-block h-1 w-11 shrink-0 overflow-hidden rounded-full bg-muted">
      <span
        className={cn("block h-full rounded-full", TONE_FILL[tone])}
        style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
      />
    </span>
  );
}

/**
 * Pace and countdown read the clock when the item mounts (keyed on the window's
 * data, so every update remounts it) and again when the tooltip opens. No timer.
 */
function LimitWindowItem({ window }: { readonly window: ServerProviderUsageWindow }) {
  const [now, setNow] = useState(Date.now);
  const pace = statuslinePace(window, now);
  const tone = pace?.tone ?? "early";
  const percent = Math.round(window.usedPercent);
  const resetsIn = formatResetsIn(window, now);
  return (
    <Tooltip onOpenChange={(open) => open && setNow(Date.now())}>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="micro"
            aria-label={`${window.label} limit ${percent}% used${resetsIn ? `, ${resetsIn}` : ""}`}
          />
        }
      >
        <span>{SHORT_LABEL[window.kind] ?? window.label}</span>
        <UsageBar percent={window.usedPercent} tone={tone} />
        {pace ? (
          <span aria-hidden className={cn("font-bold", TONE_TEXT[tone])}>
            {pace.glyph}
          </span>
        ) : null}
        <span className={cn("tabular-nums", pace && TONE_TEXT[tone])}>{percent}%</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            {window.label} limit · {percent}% used
          </span>
          {resetsIn ? <span className="first-letter:uppercase">{resetsIn}</span> : null}
          {pace?.projectedPercent != null ? (
            <span className={TONE_TEXT[pace.tone]}>
              On pace for ~{pace.projectedPercent}% at reset
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Context fill and the selected account's session and weekly limits, for the composer footer. */
export function ComposerUsageStrip({
  contextWindow,
  usageLimits,
}: {
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly usageLimits: ServerProviderUsageLimits | undefined;
}) {
  const windows = stripWindows(usageLimits);
  const contextPercent = contextWindow?.usedPercentage ?? null;
  if (contextPercent === null && windows.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-1 tabular-nums">
      {contextWindow !== null && contextPercent !== null ? (
        <span
          className="flex items-center gap-1.5 px-1.5"
          aria-label={`Context window ${formatContextWindowTokens(contextWindow.usedTokens)} of ${formatContextWindowTokens(contextWindow.maxTokens ?? null)} tokens`}
        >
          <UsageBar percent={contextPercent} tone={contextTone(contextPercent)} />
          <span>
            <span className={TONE_TEXT[contextTone(contextPercent)]}>
              {formatContextWindowTokens(contextWindow.usedTokens)}
            </span>
            {" / "}
            {formatContextWindowTokens(contextWindow.maxTokens ?? null)}
          </span>
        </span>
      ) : null}
      {windows.map((window) => (
        <LimitWindowItem
          key={`${window.id}:${window.usedPercent}:${window.resetsAt ?? ""}`}
          window={window}
        />
      ))}
    </div>
  );
}
