import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ClaudeAccountAddRespondInput,
  ClaudeAccountAddState,
  ClaudeAccountError,
  ClaudeAccountErrorReason,
  ClaudeAccountList,
  ClaudeAccountRememberInput,
  ClaudeAccountSwitchInput,
  ClaudeSwitchResult,
} from "./claudeAccounts.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderAuthResponse } from "./providerSetup.ts";

const encodeError = Schema.encodeUnknownSync(ClaudeAccountError);
const decodeError = Schema.decodeUnknownSync(ClaudeAccountError);
const decodeList = Schema.decodeUnknownSync(ClaudeAccountList);
const encodeList = Schema.encodeUnknownSync(ClaudeAccountList);
const decodeRememberInput = Schema.decodeUnknownSync(ClaudeAccountRememberInput);
const decodeSwitchInput = Schema.decodeUnknownSync(ClaudeAccountSwitchInput);
const decodeSwitchResult = Schema.decodeUnknownSync(ClaudeSwitchResult);
const encodeSwitchResult = Schema.encodeUnknownSync(ClaudeSwitchResult);
const roundTripError = (error: ClaudeAccountError) => decodeError(encodeError(error));
const encodeAddState = Schema.encodeUnknownSync(ClaudeAccountAddState);
const decodeAddState = Schema.decodeUnknownSync(ClaudeAccountAddState);
const decodeRespond = Schema.decodeUnknownSync(ClaudeAccountAddRespondInput);
const decodeAuthResponse = Schema.decodeUnknownSync(ProviderAuthResponse);

describe("ClaudeAccountError", () => {
  it.each(ClaudeAccountErrorReason.literals)(
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

  it("round-trips a switch result with two affected setups unchanged", () => {
    const result = {
      instanceId: "claudeAgent_work",
      active: { name: "Work", email: "work@example.com" },
      affectedInstanceIds: ["claudeAgent_work", "claudeAgent_copy"],
    };
    expect(encodeSwitchResult(decodeSwitchResult(result))).toEqual(result);
  });

  it("refuses a switch without stopRunningTurns or with a name over 256 characters", () => {
    const input = { instanceId: "claudeAgent", name: "Work", stopRunningTurns: false };
    expect(decodeSwitchInput(input).stopRunningTurns).toBe(false);
    expect(() => decodeSwitchInput({ instanceId: "claudeAgent", name: "Work" })).toThrow();
    expect(() => decodeSwitchInput({ ...input, name: "a".repeat(257) })).toThrow();
  });
});

describe("Claude account add wire schemas", () => {
  it("R11: covers all 22 reasons, including the three login reasons", () => {
    expect(ClaudeAccountErrorReason.literals).toHaveLength(22);
    expect(ClaudeAccountErrorReason.literals).toEqual(
      expect.arrayContaining(["loginFailed", "loginTimedOut", "loginNotFound"]),
    );
  });

  it("round-trips a failed add state, keeping the error's reason and message", () => {
    const state = {
      attemptId: "attempt-1",
      instanceId: ProviderInstanceId.make("claudeAgent"),
      name: "Private",
      phase: "failed" as const,
      output: "",
      outputOffset: 0,
      account: null,
      error: new ClaudeAccountError({ reason: "nameInUse", name: "Private" }),
    };
    const decoded = decodeAddState(encodeAddState(state));
    expect(decoded.error?.reason).toBe("nameInUse");
    expect(decoded.error?.message).toBe(state.error.message);
  });

  it("refuses respond data over 4096 characters and a terminal with no columns", () => {
    expect(decodeRespond({ attemptId: "a", data: "x".repeat(4096) }).data).toHaveLength(4096);
    expect(() => decodeRespond({ attemptId: "a", data: "x".repeat(4097) })).toThrow();
    expect(() =>
      decodeRespond({ attemptId: "a", data: "x", size: { cols: 0, rows: 24 } }),
    ).toThrow();
  });

  it("still decodes a terminal provider auth response", () => {
    const response = { type: "terminal", data: "x", size: { cols: 80, rows: 24 } };
    expect(decodeAuthResponse(response)).toEqual(response);
  });
});
