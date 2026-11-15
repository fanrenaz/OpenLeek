import { observerRunIdFromRoute } from "../../../observer-poll";
import { SocialObserverClient } from "./social-observer-client";

export default async function SocialObserverPage({ params }: { params: Promise<{ runId: string }> }) {
  return <SocialObserverClient runId={observerRunIdFromRoute((await params).runId)} />;
}
