import type { Mutation } from "../domain/models";
import type { SocialContextRevision } from "./revision-model";
import { SocialEnvironmentService } from "./social-environment-service";

/** Legacy transport-shaped test port. Production settles directly at seal. */
export interface SocialCommandStreamMessage {
  streamId: string;
  runId: string;
  roundId: number;
  commandId: string;
}

export interface SocialCommandStream {
  publish(message: { streamKey: string; runId: string; roundId: number; commandId: string }): Promise<string>;
  acknowledge(message: SocialCommandStreamMessage): Promise<void>;
}

export interface SocialCompletionPublisher {
  publish(event: {
    context: "social_environment";
    runId: string;
    roundId: number;
    baseRevisionRef: string;
    readRevisionRef: string;
    candidateRevision: SocialContextRevision;
  }): Promise<void>;
}

/** Compatibility harness for owner tests; no production runtime starts it. */
export class SocialContextWorker {
  constructor(
    private readonly social: SocialEnvironmentService,
    private readonly stream: SocialCommandStream,
    private readonly completions?: SocialCompletionPublisher,
  ) {}

  async publishPending(runId: string, roundId: number): Promise<number> {
    const pending = this.social.pendingOutbox(runId, roundId);
    for (const outbox of pending) {
      const streamId = await this.stream.publish({
        streamKey: outbox.streamKey,
        runId: outbox.payload.runId,
        roundId: outbox.payload.roundId,
        commandId: outbox.payload.commandId,
      });
      await this.social.markOutboxPublished({ runId, roundId, commandId: outbox.commandId, streamId });
    }
    return pending.length;
  }

  async consume(message: SocialCommandStreamMessage): Promise<void> {
    await this.social.applyQueuedIntent(message);
    await this.stream.acknowledge(message);
  }

  async discardFailedTurns(input: { runId: string; roundId: number; turnIds: readonly string[] }): Promise<void> {
    await this.social.discardTurns(input);
  }

  async seal(input: {
    runId: string;
    roundId: number;
    baseRevision: SocialContextRevision;
    readRevision: SocialContextRevision;
    finalFailedTurnIds: readonly string[];
    mutation: Mutation;
  }): Promise<SocialContextRevision> {
    const candidateRevision = await this.social.sealCandidateRevision(input);
    await this.completions?.publish({
      context: "social_environment",
      runId: input.runId,
      roundId: input.roundId,
      baseRevisionRef: input.baseRevision.ref,
      readRevisionRef: input.readRevision.ref,
      candidateRevision,
    });
    return candidateRevision;
  }
}
