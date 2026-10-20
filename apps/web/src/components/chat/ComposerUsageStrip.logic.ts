import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { elapsedShare } from "@t3tools/shared/usageLimits";

export type UsageTone = "ok" | "warn" | "critical" | "early";

export interface StatuslinePace {
  readonly tone: UsageTone;
  readonly glyph: "▼" | "●" | "▲" | "✖" | "◌";
  /** Usage at reset if spending continues at the current rate; null when not projected. */
  readonly projectedPercent: number | null;
}

/** Context fill: ok below half, warn from half, critical from 80%. */
export function contextTone(usedPercent: number): UsageTone {
  if (usedPercent >= 80) return "critical";
  if (usedPercent >= 50) return "warn";
  return "ok";
}

/**
 * Projects the window's usage to its reset and grades the outcome: over 100%
 * means the limit will be hit before the reset, 80% or more is close. The first
 * 5% of a window is too short to project. Null when the reset or length is unknown.
 */
export function statuslinePace(
  window: ServerProviderUsageWindow,
  now: number,
): StatuslinePace | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return null;
  if (window.usedPercent >= 100) return { tone: "critical", glyph: "✖", projectedPercent: null };
  if (elapsed < 0.05) return { tone: "early", glyph: "◌", projectedPercent: null };
  const projectedPercent = Math.round(window.usedPercent / elapsed);
  if (projectedPercent > 100) return { tone: "critical", glyph: "▲", projectedPercent };
  if (projectedPercent >= 80) return { tone: "warn", glyph: "●", projectedPercent };
  return { tone: "ok", glyph: "▼", projectedPercent };
}

const STRIP_KINDS = [
  { kind: "session", label: "Session" },
  { kind: "weekly", label: "Weekly" },
] as const;

/**
 * The session and weekly windows, in that order. Model-scoped buckets share
 * the weekly kind under their model's name, so the account-wide window is the
 * one carrying the generic label.
 */
export function stripWindows(
  limits: ServerProviderUsageLimits | undefined,
): ServerProviderUsageWindow[] {
  if (!limits || limits.unavailable) return [];
  return STRIP_KINDS.flatMap(({ kind, label }) => {
    const ofKind = limits.windows.filter((window) => window.kind === kind);
    const window = ofKind.find((candidate) => candidate.label === label) ?? ofKind[0];
    return window ? [window] : [];
  });
}
