import { SocialDomainError } from "./errors";

const SOCIAL_WRITE_TOOLS = new Set([
  "create_post",
  "like_post",
  "repost_post",
  "reply_to_post",
  "follow",
  "unfollow",
  "engage",
]);

export function socialRequestIdentity(value: string | number | undefined): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length > 500) {
    throw new Error("Social write request is missing its transport identity");
  }
  return `${typeof value}:${String(value)}`;
}

export function socialAcknowledgement(name: string, args: Record<string, unknown>): string {
  if (name === "create_post") return "Post submitted successfully.";
  if (name === "like_post" || (name === "engage" && args.engagement === "like")) return "Like submitted successfully.";
  if (name === "repost_post" || (name === "engage" && args.engagement === "repost")) return "Repost submitted successfully.";
  if (name === "reply_to_post" || (name === "engage" && args.engagement === "reply")) return "Reply submitted successfully.";
  if (name === "follow") return "Follow request submitted successfully.";
  if (name === "unfollow") return "Unfollow request submitted successfully.";
  return "Social action submitted successfully.";
}

export function publicSocialMcpError(name: string | undefined, error: unknown): string {
  if (!isSocialWriteTool(name)) return error instanceof Error ? error.message : String(error);
  if (error instanceof SocialDomainError) {
    if (error.code === "INVALID_ARGUMENT") return error.message;
    if (error.code === "NOT_FOUND") return "The requested social item is unavailable.";
    if (error.code === "PRECONDITION_FAILED" && error.message.includes("maximum actions per round")) {
      return "Social action limit reached for this round.";
    }
  }
  return "Social action could not be submitted.";
}

export function isSocialWriteTool(name: string | undefined): boolean {
  return name !== undefined && SOCIAL_WRITE_TOOLS.has(name);
}
