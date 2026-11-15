import "@openleek/observability/bootstrap";

export async function registerNodeInstrumentation(): Promise<void> {
  if (process.env.OPENLEEK_EXPERIMENT_WORKER !== "true") return;
  const { startExperimentWorker } = await import("./server/worker-runner");
  await startExperimentWorker();
}
