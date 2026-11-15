import { assign, setup } from "xstate";

export type RunAction = "resume" | "retry" | "cancel" | "fork";

export type RunActionContext = {
  action: RunAction | undefined;
  error: string | undefined;
  result: string | undefined;
};

export type RunActionEvent =
  | { type: "REQUEST"; action: RunAction }
  | { type: "CONFIRM" }
  | { type: "DISMISS" }
  | { type: "SUCCEED"; result: string }
  | { type: "FAIL"; error: string };

/**
 * Keeps destructive and state-changing run actions behind a single explicit
 * confirmation path. Network work remains in the React feature, so this
 * machine is deterministic and directly testable.
 */
export const runActionMachine = setup({
  types: {} as { context: RunActionContext; events: RunActionEvent },
}).createMachine({
  id: "runAction",
  initial: "idle",
  context: { action: undefined, error: undefined, result: undefined },
  states: {
    idle: {
      on: {
        REQUEST: {
          target: "confirming",
          actions: assign(({ event }) => ({ action: event.action, error: undefined, result: undefined })),
        },
      },
    },
    confirming: {
      on: {
        CONFIRM: "submitting",
        DISMISS: { target: "idle", actions: assign(() => ({ action: undefined, error: undefined, result: undefined })) },
      },
    },
    submitting: {
      on: {
        SUCCEED: { target: "succeeded", actions: assign(({ event }) => ({ result: event.result, error: undefined })) },
        FAIL: { target: "failed", actions: assign(({ event }) => ({ error: event.error, result: undefined })) },
      },
    },
    succeeded: {
      on: { DISMISS: { target: "idle", actions: assign(() => ({ action: undefined, error: undefined, result: undefined })) } },
    },
    failed: {
      on: { DISMISS: { target: "idle", actions: assign(() => ({ action: undefined, error: undefined, result: undefined })) } },
    },
  },
});
