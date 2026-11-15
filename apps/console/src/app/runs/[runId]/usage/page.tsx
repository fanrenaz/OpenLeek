import { RunWorkspacePage } from "../../../../components/run-workspace-page";

export default async function UsagePage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <RunWorkspacePage runId={decodeURIComponent(runId)} view="usage" />;
}
