import "@openleek/observability/bootstrap";

export async function registerNodeInstrumentation(): Promise<void> {
  if (process.env.OPENLEEK_SOCIAL_ENVIRONMENT_WORKER !== "true") return;
  const { startSocialEnvironmentWorker } = await import("./server/worker-runner");
  await startSocialEnvironmentWorker();
}
