export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@openleek/observability/bootstrap");
  }
}
