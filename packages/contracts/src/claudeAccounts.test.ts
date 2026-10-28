import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ClaudeAccountError,
  ClaudeAccountErrorReason,
  ClaudeAccountList,
  ClaudeAccountRememberInput,
} from "./claudeAccounts.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const encodeError = Schema.encodeUnknownSync(ClaudeAccountError);
const decodeError = Schema.decodeUnknownSync(ClaudeAccountError);
const decodeList = Schema.decodeUnknownSync(ClaudeAccountList);
const encodeList = Schema.encodeUnknownSync(ClaudeAccountList);
const decodeRememberInput = Schema.decodeUnknownSync(ClaudeAccountRememberInput);
const roundTripError = (error: ClaudeAccountError) => decodeError(encodeError(error));

const LIST_REMEMBER_FORGET_REASONS = [
  "unavailable",
  "setupNotFound",
  "setupUnreadable",
  "notLoggedIn",
  "invalidName",
  "nameInUse",
  "alreadyRemembered",
  "accountNotFound",
  "storage",
] as const;

describe("ClaudeAccountError", () => {
  it.each(LIST_REMEMBER_FORGET_REASONS)(
    "R11: the %s message is plain language without setup ID or command line",
    (reason) => {
      const { message } = new ClaudeAccountError({
        reason,
        instanceId: ProviderInstanceId.make("claudeAgent_work"),
        name: "Work",
      });
      expect(message).not.toBe("");
      for (const forbidden of ["claudeAgent_work", "`", "claude auth", "CLAUDE_CONFIG_DIR"]) {
        expect(message).not.toContain(forbidden);
      }
    },
  );

  it("rebuilds the same message on the client after crossing the wire", () => {
    const error = new ClaudeAccountError({ reason: "nameInUse", name: "Work" });
    const decoded = roundTripError(error);
    expect(decoded.reason).toBe("nameInUse");
    expect(decoded.name).toBe("Work");
    expect(decoded.message).toBe(error.message);
  });

  it.each(ClaudeAccountErrorReason.literals)(
    "round-trips %s with no fields, only a name and only a setup",
    (reason) => {
      for (const fields of [
        {},
        { name: "Work" },
        { instanceId: ProviderInstanceId.make("claudeAgent") },
      ]) {
        const error = new ClaudeAccountError({ reason, ...fields });
        const decoded = roundTripError(error);
        expect(decoded.reason).toBe(reason);
        expect(decoded.message).toBe(error.message);
      }
    },
  );

  it("decodes a reason unknown to this build as undefined with a generic message", () => {
    const decoded = decodeError({
      _tag: "ClaudeAccountError",
      reason: "someFutureReason",
      name: "Work",
    });
    expect(decoded.reason).toBeUndefined();
    expect(decoded.message).toBe(
      "T3 refused this Claude account action. Try again, or update T3 on both ends.",
    );
  });
});

describe("Claude account wire schemas", () => {
  it("round-trips an account list unchanged", () => {
    const list = {
      accounts: [
        { name: "Work", email: "work@example.com" },
        { name: "Private", email: "private@example.com" },
      ],
      setups: [
        { instanceId: "claudeAgent", displayName: null, active: null },
        {
          instanceId: "claudeAgent_work",
          displayName: "Claude Work",
          active: { email: "other@example.com", rememberedAs: null },
        },
      ],
    };
    expect(encodeList(decodeList(list))).toEqual(list);
  });

  it("refuses an account name longer than 256 characters", () => {
    expect(
      decodeRememberInput({ instanceId: "claudeAgent", name: "a".repeat(256) }).name,
    ).toHaveLength(256);
    expect(() =>
      decodeRememberInput({ instanceId: "claudeAgent", name: "a".repeat(257) }),
    ).toThrow();
  });
});
