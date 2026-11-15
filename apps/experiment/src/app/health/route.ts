import { startExperimentWorker } from "../../server/worker-runner";

export const runtime = "nodejs";

export function GET() {
  // The dedicated Compose service's health probe is also its compiled Worker
  // entry trigger. The global guard ensures subsequent probes do not start a
  // second consumer in the process.
  if (process.env.OPENLEEK_EXPERIMENT_WORKER === "true") startExperimentWorker();
  return Response.json({ status: "ok", service: "experiment" });
}
