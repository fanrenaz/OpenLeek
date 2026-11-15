import { observerRunIdFromRoute } from "../../../observer-poll";
import { FinancialObserverClient } from "./financial-observer-client";

export default async function FinancialObserverPage({ params }: { params: Promise<{ runId: string }> }) {
  return <FinancialObserverClient runId={observerRunIdFromRoute((await params).runId)} />;
}
