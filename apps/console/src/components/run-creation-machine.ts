import { assign, setup } from "xstate";
import { defaultRunForm, type RunFormState } from "./run-form-model";

export const RUN_CREATION_DRAFT_VERSION = 2;
export const RUN_CREATION_DRAFT_KEY = "openleek.console.run-creation.v2";
export const runCreationSteps = ["World", "Execution", "Social", "Financial", "Review"] as const;

export type RunCreationDraft = { version: typeof RUN_CREATION_DRAFT_VERSION; activeStep: number; form: RunFormState };
type RunCreationContext = { activeStep: number; form: RunFormState; preflight?: unknown | undefined; error?: string | undefined; runId?: string | undefined };
type RunCreationEvent =
  | { type: "FORM_CHANGED"; form: RunFormState }
  | { type: "STEP_SELECTED"; activeStep: number }
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "PREFLIGHT_REQUESTED" }
  | { type: "PREFLIGHT_SUCCEEDED"; result: unknown }
  | { type: "PREFLIGHT_FAILED"; error: string }
  | { type: "CREATE_REQUESTED" }
  | { type: "CREATE_SUCCEEDED"; runId: string }
  | { type: "CREATE_FAILED"; error: string };

const clampStep = (value: number) => Math.max(0, Math.min(runCreationSteps.length - 1, value));

export const runCreationMachine = setup({
  types: {
    context: {} as RunCreationContext,
    events: {} as RunCreationEvent,
    input: {} as RunCreationDraft | undefined,
  },
}).createMachine({
  id: "runCreation",
  initial: "editing",
  context: ({ input }) => ({
    activeStep: input ? clampStep(input.activeStep) : 0,
    form: input?.form ?? defaultRunForm(),
  }),
  states: {
    editing: {
      on: {
        FORM_CHANGED: { actions: assign(({ event }) => ({ form: event.form, preflight: undefined, error: undefined })) },
        STEP_SELECTED: { actions: assign(({ event }) => ({ activeStep: clampStep(event.activeStep) })) },
        NEXT: { actions: assign(({ context }) => ({ activeStep: clampStep(context.activeStep + 1) })) },
        BACK: { actions: assign(({ context }) => ({ activeStep: clampStep(context.activeStep - 1) })) },
        PREFLIGHT_REQUESTED: { target: "preflighting", actions: assign({ error: () => undefined }) },
      },
    },
    preflighting: {
      on: {
        PREFLIGHT_SUCCEEDED: { target: "preflighted", actions: assign(({ event }) => ({ preflight: event.result, error: undefined })) },
        PREFLIGHT_FAILED: { target: "editing", actions: assign(({ event }) => ({ error: event.error, preflight: undefined })) },
      },
    },
    preflighted: {
      on: {
        FORM_CHANGED: { target: "editing", actions: assign(({ event }) => ({ form: event.form, preflight: undefined, error: undefined })) },
        STEP_SELECTED: { actions: assign(({ event }) => ({ activeStep: clampStep(event.activeStep) })) },
        NEXT: { actions: assign(({ context }) => ({ activeStep: clampStep(context.activeStep + 1) })) },
        BACK: { actions: assign(({ context }) => ({ activeStep: clampStep(context.activeStep - 1) })) },
        CREATE_REQUESTED: { target: "creating", actions: assign({ error: () => undefined }) },
      },
    },
    creating: {
      on: {
        CREATE_SUCCEEDED: { target: "created", actions: assign(({ event }) => ({ runId: event.runId, error: undefined })) },
        CREATE_FAILED: { target: "preflighted", actions: assign(({ event }) => ({ error: event.error })) },
      },
    },
    created: { type: "final" },
  },
});

/** Only local, editable data is persisted: no runtime capability or preflight result. */
export function serializeRunCreationDraft(activeStep: number, form: RunFormState): string {
  return JSON.stringify({ version: RUN_CREATION_DRAFT_VERSION, activeStep: clampStep(activeStep), form } satisfies RunCreationDraft);
}

export function parseRunCreationDraft(value: string | null): RunCreationDraft | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Partial<RunCreationDraft>;
    const activeStep = candidate.activeStep;
    if (candidate.version !== RUN_CREATION_DRAFT_VERSION || typeof activeStep !== "number" || !Number.isInteger(activeStep) || !candidate.form || typeof candidate.form !== "object" || Array.isArray(candidate.form)) return undefined;
    const stored = candidate.form as Partial<RunFormState>;
    const defaults = defaultRunForm();
    const runtime = stored.runtime?.provider === "openai" || stored.runtime?.provider === "deepseek" ? stored.runtime : defaults.runtime;
    return { version: RUN_CREATION_DRAFT_VERSION, activeStep: clampStep(activeStep), form: { ...defaults, ...stored, runtime } as RunFormState };
  } catch { return undefined; }
}
