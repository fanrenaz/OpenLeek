import { RunWorkspacePage } from "../../../../components/run-workspace-page";

export default async function ResultsPage({ params }: { params: Promise<{ runId: string }> }) {
  return <RunWorkspacePage runId={decodeURIComponent((await params).runId)} view="results" />;
}
