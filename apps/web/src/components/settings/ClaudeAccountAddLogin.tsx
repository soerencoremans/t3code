import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  ClaudeAccountAddAttemptId,
  ClaudeAccountAddRespondInput,
  EnvironmentId,
  ProviderAuthResponse,
  RememberedClaudeAccount,
} from "@t3tools/contracts";
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { claudeAccountErrorMessage } from "./claudeAccounts.logic";
import { CLAUDE_ACCOUNT_COMMAND_OPTIONS } from "./useClaudeAccounts";

const ProviderAuthTerminal = lazy(() => import("./ProviderAuthTerminal"));

const TERMINAL_CHUNK = 4_096;

export type ClaudeAccountAddOutcome =
  | { readonly kind: "succeeded"; readonly account: RememberedClaudeAccount }
  | { readonly kind: "failed"; readonly message: string };

export function ClaudeAccountAddLogin({
  environmentId,
  attemptId,
  onEnded,
}: {
  readonly environmentId: EnvironmentId;
  readonly attemptId: ClaudeAccountAddAttemptId;
  readonly onEnded: (outcome: ClaudeAccountAddOutcome) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.claudeAccountAddState({ environmentId, input: { attemptId } }),
  );
  // The terminal input carries the login code, so failures are never toasted or logged.
  const respond = useAtomCommand(
    serverEnvironment.respondClaudeAccountAdd,
    CLAUDE_ACCOUNT_COMMAND_OPTIONS,
  );
  const cancel = useAtomCommand(
    serverEnvironment.cancelClaudeAccountAdd,
    CLAUDE_ACCOUNT_COMMAND_OPTIONS,
  );
  const [alert, setAlert] = useState<string | null>(null);
  const endedRef = useRef(false);
  const mountedRef = useRef(false);
  const queue = useRef<ClaudeAccountAddRespondInput[]>([]);
  const sending = useRef(false);
  const data = query.data;
  const failure = query.failure;

  const end = useEffectEvent((outcome: ClaudeAccountAddOutcome) => {
    endedRef.current = true;
    onEnded(outcome);
  });
  useEffect(() => {
    if (data?.phase === "succeeded") {
      end(
        data.account === null
          ? {
              kind: "failed",
              message: "The account may have been added. Check the remembered accounts.",
            }
          : { kind: "succeeded", account: data.account },
      );
    } else if (data?.phase === "failed") {
      end({ kind: "failed", message: claudeAccountErrorMessage(data.error) });
    } else if (data?.phase === "cancelled") {
      end({ kind: "failed", message: "This login was stopped. Start again." });
    } else if (failure !== null) {
      end({ kind: "failed", message: claudeAccountErrorMessage(failure) });
    }
  }, [data, failure]);

  // Every way out of the dialog unmounts this step, so this is the only cancel. The microtask
  // lets StrictMode's simulated remount set `mountedRef` again before anything is sent.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (!mountedRef.current && !endedRef.current) {
          void cancel({ environmentId, input: { attemptId } });
        }
      });
    };
  }, [environmentId, attemptId, cancel]);

  const sendQueued = async () => {
    while (queue.current.length > 0) {
      const input = queue.current.shift()!;
      const result = await respond({ environmentId, input });
      if (result._tag !== "Success") {
        queue.current = [];
        if (!isAtomCommandInterrupted(result)) {
          setAlert("The login terminal is no longer available. Start again.");
        }
        return;
      }
    }
  };

  const onResponse = (response: Extract<ProviderAuthResponse, { type: "terminal" }>) => {
    // At least one chunk, so a resize with empty data is still sent.
    for (let offset = 0; offset < Math.max(1, response.data.length); offset += TERMINAL_CHUNK) {
      queue.current.push({
        attemptId,
        data: response.data.slice(offset, offset + TERMINAL_CHUNK),
        ...(response.size ? { size: response.size } : {}),
      });
    }
    if (sending.current) return;
    sending.current = true;
    void sendQueued()
      .catch(() => {
        queue.current = [];
        setAlert("The login terminal is no longer available. Start again.");
      })
      .finally(() => {
        sending.current = false;
      });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="py-2">
        <Suspense
          fallback={<p className="text-xs text-muted-foreground">Loading login terminal…</p>}
        >
          <ProviderAuthTerminal
            output={data?.output ?? ""}
            outputOffset={data?.outputOffset ?? 0}
            onResponse={onResponse}
          />
        </Suspense>
      </div>
      <p className="text-xs text-muted-foreground">
        Open the link in a browser and log in with the account you want to add. If the browser is on
        another device, log in there and paste the code it shows into the terminal.
      </p>
      {data === null || data.phase === "running" ? (
        <p role="status" className="text-xs text-muted-foreground">
          Waiting for login… “Done” turns on once the login lands.
        </p>
      ) : null}
      {alert !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {alert}
        </p>
      ) : null}
    </div>
  );
}
