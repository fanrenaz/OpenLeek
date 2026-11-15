import { assign, setup } from "xstate";

export type AssetEditorContext = { error?: string };
export type AssetEditorEvent =
  | { type: "LOAD" }
  | { type: "LOADED" }
  | { type: "EDIT" }
  | { type: "SAVE" }
  | { type: "VALIDATE" }
  | { type: "REQUEST_PUBLISH" }
  | { type: "PUBLISH" }
  | { type: "SUCCESS" }
  | { type: "FAIL"; error: string }
  | { type: "DISMISS" };

/**
 * A feature-local state model for asset editors. Network calls intentionally
 * remain in the React features; this statechart keeps their user-visible
 * lifecycle deterministic and makes publish confirmation non-bypassable.
 */
export const assetEditorMachine = setup({
  types: {} as { context: AssetEditorContext; events: AssetEditorEvent },
}).createMachine({
  id: "assetEditor",
  initial: "loading",
  context: {},
  states: {
    loading: { on: { LOADED: "ready", FAIL: { target: "failure", actions: assign(({ event }) => ({ error: event.error })) } } },
    ready: {
      on: {
        LOAD: "loading",
        EDIT: "dirty",
        SAVE: "saving",
        VALIDATE: "validating",
        REQUEST_PUBLISH: "confirmingPublish",
      },
    },
    dirty: {
      on: {
        LOAD: "loading",
        SAVE: "saving",
        VALIDATE: "validating",
        REQUEST_PUBLISH: "confirmingPublish",
      },
    },
    saving: { on: { SUCCESS: "ready", FAIL: { target: "failure", actions: assign(({ event }) => ({ error: event.error })) } } },
    validating: { on: { SUCCESS: "ready", FAIL: { target: "failure", actions: assign(({ event }) => ({ error: event.error })) } } },
    confirmingPublish: { on: { DISMISS: "dirty", PUBLISH: "publishing" } },
    publishing: { on: { SUCCESS: "ready", FAIL: { target: "failure", actions: assign(({ event }) => ({ error: event.error })) } } },
    failure: {
      on: {
        DISMISS: "ready",
        EDIT: "dirty",
        LOAD: "loading",
      },
    },
  },
});
