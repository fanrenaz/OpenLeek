export const observerPollIntervalMs = 10_000;

export function observerRunIdFromRoute(value: string): string {
  return decodeURIComponent(value);
}
