import { assign, setup } from "xstate";

export type OperationKind = "idle" | "loading" | "saving" | "success" | "failure";

export const operationMachine = setup({
  types: {} as {
    context: { message: string };
    events:
      | { type: "START"; message: string }
      | { type: "SUCCEED"; message: string }
      | { type: "FAIL"; message: string }
      | { type: "RESET" };
  },
}).createMachine({
  context: { message: "" },
  id: "consoleOperation",
  initial: "idle",
  states: {
    idle: { on: { START: { target: "loading", actions: assign({ message: ({ event }) => event.message }) } } },
    loading: {
      on: {
        START: { target: "saving", actions: assign({ message: ({ event }) => event.message }) },
        SUCCEED: { target: "success", actions: assign({ message: ({ event }) => event.message }) },
        FAIL: { target: "failure", actions: assign({ message: ({ event }) => event.message }) },
      },
    },
    saving: {
      on: {
        SUCCEED: { target: "success", actions: assign({ message: ({ event }) => event.message }) },
        FAIL: { target: "failure", actions: assign({ message: ({ event }) => event.message }) },
      },
    },
    success: { on: { START: { target: "loading", actions: assign({ message: ({ event }) => event.message }) }, RESET: "idle" } },
    failure: { on: { START: { target: "loading", actions: assign({ message: ({ event }) => event.message }) }, RESET: "idle" } },
  },
});
