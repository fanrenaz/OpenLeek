import { RunWorkspacePage } from "../../../../components/run-workspace-page";

export default async function EvidencePage({ params }: { params: Promise<{ runId: string }> }) {
  return <RunWorkspacePage runId={decodeURIComponent((await params).runId)} view="evidence" />;
}
