import assert from "node:assert/strict";
import test from "node:test";
import { socialMcpToolDefinitions } from "../src/app/internal/mcp/tool-definitions";
import { SocialDomainError } from "../src/application/errors";
import {
  publicSocialMcpError,
  socialAcknowledgement,
  socialRequestIdentity,
} from "../src/application/mcp-write-presentation";

test("Social write tools expose only user action fields and natural acknowledgements", () => {
  const definitions = new Map<string, Record<string, unknown>>(
    socialMcpToolDefinitions.map(([name, _description, properties]) => [name, properties]),
  );
  assert.equal(definitions.has("get_command_status"), false);
  assert.equal("postId" in definitions.get("create_post")!, false);
  assert.equal("repostId" in definitions.get("repost_post")!, false);
  assert.equal("replyId" in definitions.get("reply_to_post")!, false);
  assert.equal(socialAcknowledgement("create_post", {}), "Post submitted successfully.");
  assert.equal(socialAcknowledgement("engage", { engagement: "reply" }), "Reply submitted successfully.");
});

test("Social write presentation keeps transport identity internal and redacts infrastructure errors", () => {
  assert.equal(socialRequestIdentity(17), "number:17");
  assert.throws(() => socialRequestIdentity(undefined), /transport identity/);
  assert.equal(
    publicSocialMcpError("create_post", new SocialDomainError("INTERNAL", "worktree revision collision")),
    "Social action could not be submitted.",
  );
  assert.equal(
    publicSocialMcpError("create_post", new SocialDomainError("NOT_FOUND", "unknown internal post: secret-id")),
    "The requested social item is unavailable.",
  );
});
