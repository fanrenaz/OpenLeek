import { pluginManifestSchema, runStatusSchema } from "@openleek/contracts/experiment";
import { networkConsolePorts, type ConsolePorts } from "./ports";

export async function observerRunHead(runId: string, ports: ConsolePorts = networkConsolePorts()) {
  const record = await ports.getRun({ runId }) as { status?: unknown };
  const status = runStatusSchema.parse(record.status ?? record);
  if (!status.committedManifestRef) return { ...status, manifest: null };
  const manifest = pluginManifestSchema.parse(await ports.committedManifest({
    runId,
    manifestRef: status.committedManifestRef,
  }));
  return {
    ...status,
    manifest: {
      ref: manifest.ref,
      roundId: manifest.roundId,
      contexts: manifest.contexts,
    },
  };
}

export async function observerRunRounds(
  runId: string,
  input: { cursor?: string; limit: number },
  ports: ConsolePorts = networkConsolePorts(),
) {
  const value = await ports.committedRounds({ runId, ...input }) as {
    items?: unknown[];
    nextCursor?: string;
  };
  const items = (value.items ?? []).map((item) => {
    const manifest = pluginManifestSchema.parse(item);
    return {
      roundId: manifest.roundId,
      manifestRef: manifest.ref,
      contexts: manifest.contexts,
    };
  }).sort((left, right) => left.roundId - right.roundId);
  return { items, ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }) };
}
