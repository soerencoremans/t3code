import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { contextTone, statuslinePace, stripWindows } from "./ComposerUsageStrip.logic";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const HOUR = 3_600_000;

/** A five-hour window that has run for `elapsedHours`. */
function sessionWindow(
  usedPercent: number,
  elapsedHours: number,
  overrides: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow {
  return {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    resetsAt: new Date(NOW + (5 - elapsedHours) * HOUR).toISOString(),
    windowDurationMins: 300,
    ...overrides,
  };
}

describe("contextTone", () => {
  it("is ok below half, warn from half, critical from 80%", () => {
    expect(contextTone(49)).toBe("ok");
    expect(contextTone(50)).toBe("warn");
    expect(contextTone(79)).toBe("warn");
    expect(contextTone(80)).toBe("critical");
  });
});

describe("statuslinePace", () => {
  it("is exhausted once the window is used up, regardless of time", () => {
    expect(statuslinePace(sessionWindow(100, 1), NOW)).toEqual({
      tone: "critical",
      glyph: "✖",
      projectedPercent: null,
    });
  });

  it("does not project in the first 5% of the window", () => {
    expect(statuslinePace(sessionWindow(10, 0.2), NOW)).toEqual({
      tone: "early",
      glyph: "◌",
      projectedPercent: null,
    });
  });

  it("is critical when the projection overshoots the limit", () => {
    // 60% used after 2.5 of 5 hours projects to 120%.
    expect(statuslinePace(sessionWindow(60, 2.5), NOW)).toEqual({
      tone: "critical",
      glyph: "▲",
      projectedPercent: 120,
    });
  });

  it("warns when the projection lands between 80% and 100%", () => {
    expect(statuslinePace(sessionWindow(42, 2.5), NOW)).toMatchObject({
      tone: "warn",
      glyph: "●",
      projectedPercent: 84,
    });
    expect(statuslinePace(sessionWindow(50, 2.5), NOW)?.tone).toBe("warn");
  });

  it("is ok when the projection stays under 80%", () => {
    expect(statuslinePace(sessionWindow(30, 2.5), NOW)).toMatchObject({
      tone: "ok",
      glyph: "▼",
      projectedPercent: 60,
    });
  });

  it("has no pace without a reset time or window length", () => {
    expect(statuslinePace(sessionWindow(42, 2.5, { resetsAt: undefined }), NOW)).toBeNull();
    expect(
      statuslinePace(sessionWindow(42, 2.5, { windowDurationMins: undefined }), NOW),
    ).toBeNull();
  });
});

describe("stripWindows", () => {
  const weekly: ServerProviderUsageWindow = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent: 78,
    windowDurationMins: 10_080,
  };
  const modelScoped: ServerProviderUsageWindow = {
    id: "seven_day_opus",
    kind: "weekly",
    label: "Opus",
    usedPercent: 12,
    windowDurationMins: 10_080,
  };

  function limits(
    windows: ServerProviderUsageWindow[],
    overrides: Partial<ServerProviderUsageLimits> = {},
  ): ServerProviderUsageLimits {
    return { checkedAt: new Date(NOW).toISOString(), windows, ...overrides };
  }

  it("returns the session window, then the account-wide weekly window", () => {
    const session = sessionWindow(42, 2.5);
    expect(stripWindows(limits([modelScoped, weekly, session]))).toEqual([session, weekly]);
  });

  it("is empty when limits are missing or unavailable", () => {
    expect(stripWindows(undefined)).toEqual([]);
    expect(stripWindows(limits([weekly], { unavailable: { reason: "unsupported" } }))).toEqual([]);
  });
});
