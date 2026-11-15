import { RunWorkspacePage } from "../../../../components/run-workspace-page";

export default async function TranscriptPage({ params }: { params: Promise<{ runId: string }> }) {
  return <RunWorkspacePage runId={decodeURIComponent((await params).runId)} view="transcript" />;
}
