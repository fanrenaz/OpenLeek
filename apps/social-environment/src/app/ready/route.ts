import { socialEnvironmentService } from "../../server/runtime";
import { requireSocialEnvironmentWorkerReady, startSocialEnvironmentWorker } from "../../server/worker-runner";

export const runtime = "nodejs";

export async function GET() {
  try {
    if (process.env.OPENLEEK_SOCIAL_ENVIRONMENT_WORKER === "true") await startSocialEnvironmentWorker();
    await socialEnvironmentService();
    await requireSocialEnvironmentWorkerReady();
    return Response.json({ status: "ready", service: "social-environment" });
  } catch (error) {
    return Response.json(
      { status: "not_ready", message: error instanceof Error ? error.message : "initialization failed" },
      { status: 503 },
    );
  }
}
