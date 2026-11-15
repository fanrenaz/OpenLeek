import type { CommittedSocialGraph } from "../domain/models";

/** A derived, replaceable graph; it is never a Social fact owner. */
export interface SocialProjection {
  replaceCommitted(graph: CommittedSocialGraph): Promise<void>;
}
