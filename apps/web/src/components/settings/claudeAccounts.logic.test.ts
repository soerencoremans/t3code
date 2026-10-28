import { ClaudeAccountError, ProviderInstanceId, type ClaudeAccountList } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeAccountErrorMessage,
  claudeAccountsAvailable,
  claudeSetupAccountView,
  claudeShareConfigSetups,
} from "./claudeAccounts.logic";

const instanceId = ProviderInstanceId.make("claudeAgent");
const work = { name: "Work", email: "bob@example.com" };
const priv = { name: "Private", email: "carol@example.org" };

function list(
  active: { email: string; rememberedAs: string | null } | null,
  accounts = [work, priv],
): ClaudeAccountList {
  return { accounts, setups: [{ instanceId, displayName: null, active }] };
}

describe("claudeAccountsAvailable (AK-33, AK-34)", () => {
  it("is true on Linux when the session may manage providers", () => {
    expect(claudeAccountsAvailable({ os: "linux", canManageProviders: true })).toBe(true);
  });

  it.each(["darwin", "windows", undefined])("is false when the os is %s", (os) => {
    expect(claudeAccountsAvailable({ os, canManageProviders: true })).toBe(false);
  });

  it("is false when the session may not manage providers", () => {
    expect(claudeAccountsAvailable({ os: "linux", canManageProviders: false })).toBe(false);
  });
});

describe("claudeSetupAccountView", () => {
  it("marks only the remembered active account as active", () => {
    expect(
      claudeSetupAccountView(list({ email: work.email, rememberedAs: "Work" }), instanceId),
    ).toEqual({
      kind: "remembered",
      name: "Work",
      email: work.email,
      accounts: [
        { ...work, active: true },
        { ...priv, active: false },
      ],
    });
  });

  it("reports a logged-in account that is not remembered, with no account active (AK-30)", () => {
    expect(
      claudeSetupAccountView(list({ email: work.email, rememberedAs: null }, [priv]), instanceId),
    ).toEqual({
      kind: "notRemembered",
      email: work.email,
      accounts: [{ ...priv, active: false }],
    });
  });

  it("reports a setup with no login as logged out", () => {
    expect(claudeSetupAccountView(list(null), instanceId)).toEqual({
      kind: "loggedOut",
      accounts: [
        { ...work, active: false },
        { ...priv, active: false },
      ],
    });
  });

  it("reports an unknown setup as logged out", () => {
    const view = claudeSetupAccountView(
      list({ email: work.email, rememberedAs: "Work" }),
      ProviderInstanceId.make("claudeAgent_other"),
    );
    expect(view).toEqual({
      kind: "loggedOut",
      accounts: [
        { ...work, active: false },
        { ...priv, active: false },
      ],
    });
  });
});

describe("claudeShareConfigSetups (AK-19, AK-20)", () => {
  const spare = {
    instanceId: ProviderInstanceId.make("claudeAgent_spare"),
    displayName: "Spare",
    active: null,
  };
  const logged = {
    instanceId,
    displayName: null,
    active: { email: "work@example.com", rememberedAs: "Work" },
  };

  it("returns only the setups with an account logged in, in the list's order", () => {
    expect(claudeShareConfigSetups({ accounts: [work], setups: [spare, logged] })).toEqual([
      logged,
    ]);
  });

  it("returns nothing when no setup is logged in", () => {
    expect(claudeShareConfigSetups({ accounts: [work], setups: [spare] })).toEqual([]);
  });

  it("returns nothing when there are no setups", () => {
    expect(claudeShareConfigSetups({ accounts: [], setups: [] })).toEqual([]);
  });
});

describe("claudeAccountErrorMessage", () => {
  it.each([
    "turnsRunning",
    "switchInProgress",
    "externalClaudePrograms",
    "nameInUse",
    "setupUnreadable",
    undefined,
  ] as const)("returns the server's message for reason %s", (reason) => {
    const error = new ClaudeAccountError({ reason, name: "Work" });
    expect(claudeAccountErrorMessage(error)).toBe(error.message);
  });

  it.each([null, "boom", new Error("internal"), undefined])(
    "falls back to a plain text for %s",
    (failure) => {
      expect(claudeAccountErrorMessage(failure)).toBe(
        "T3 could not reach the Claude accounts. Try again.",
      );
    },
  );
});
