import { RunWorkspacePage } from "../../../components/run-workspace-page";

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  return <RunWorkspacePage runId={decodeURIComponent((await params).runId)} view="overview" />;
}
