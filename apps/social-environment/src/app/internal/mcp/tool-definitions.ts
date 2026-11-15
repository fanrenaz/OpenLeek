export const socialMcpToolDefinitions = [
  ["get_feed", "Returns compact post summaries from the authenticated account's social feed. Use get_post to read one complete post.", {
    limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum number of post summaries to return. Defaults to 5." },
    cursor: { type: "string", description: "Pagination cursor returned by a previous call." },
  }, []],
  ["get_post", "Returns one available social post, its author, parent reference, and engagement totals.", {
    postId: { type: "string", description: "Post identifier." },
  }, ["postId"]],
  ["list_posts", "Returns available social posts with optional author filtering.", {
    authorId: { type: "string", description: "Author identifier to filter posts by." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of posts to return. Defaults to 25." },
    cursor: { type: "string", description: "Pagination cursor returned by a previous call." },
  }, []],
  ["search_posts", "Returns available social posts whose headline or body contains the supplied text.", {
    query: { type: "string", maxLength: 500, description: "Text matched against post headlines and bodies." },
    authorId: { type: "string", description: "Author identifier to filter posts by." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of posts to return. Defaults to 25." },
    cursor: { type: "string", description: "Pagination cursor returned by a previous call." },
  }, ["query"]],
  ["get_profile", "Returns a social profile and relationship counts.", {
    actorId: { type: "string", description: "Actor identifier. When omitted, returns the authenticated account's profile." },
  }, []],
  ["list_relationships", "Returns actors that follow the authenticated account or actors followed by it.", {
    direction: { type: "string", enum: ["followers", "following"], description: "Relationship direction to return." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of actors to return. Defaults to 25." },
    cursor: { type: "string", description: "Pagination cursor returned by a previous call." },
  }, ["direction"]],
  ["list_engagements", "Returns likes, reposts, and replies associated with one available post.", {
    postId: { type: "string", description: "Post identifier." },
    kind: { type: "string", enum: ["like", "repost", "reply"], description: "Engagement type to include." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of engagements to return. Defaults to 25." },
    cursor: { type: "string", description: "Pagination cursor returned by a previous call." },
  }, ["postId"]],
  ["get_notifications", "Returns aggregate counts and paginated details for reactions the authenticated account recently received.", {
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of reactions to return. Defaults to 25." },
    cursor: { type: "string", description: "Pagination cursor returned by a previous call." },
  }, []],
  ["create_post", "Submits a new social post.", {
    body: { type: "string", maxLength: 10_000, description: "Post body." },
    headline: { type: "string", maxLength: 500, description: "Optional post headline." },
  }, ["body"]],
  ["like_post", "Submits a like for one social post.", {
    postId: { type: "string", description: "Post identifier." },
  }, ["postId"]],
  ["repost_post", "Submits a repost that references one social post.", {
    postId: { type: "string", description: "Post identifier being reposted." },
    body: { type: "string", maxLength: 10_000, description: "Optional repost body." },
    headline: { type: "string", maxLength: 500, description: "Optional repost headline." },
  }, ["postId"]],
  ["reply_to_post", "Submits a reply that references one social post.", {
    postId: { type: "string", description: "Post identifier being replied to." },
    body: { type: "string", maxLength: 10_000, description: "Reply body." },
    headline: { type: "string", maxLength: 500, description: "Optional reply headline." },
  }, ["postId", "body"]],
  ["follow", "Submits a follow relationship.", {
    followeeId: { type: "string", description: "Actor identifier to follow." },
  }, ["followeeId"]],
  ["unfollow", "Submits removal of a follow relationship.", {
    followeeId: { type: "string", description: "Actor identifier to unfollow." },
  }, ["followeeId"]],
  ["engage", "Submits a like, repost, or reply.", {
    postId: { type: "string", description: "Post identifier." },
    engagement: { type: "string", enum: ["like", "repost", "reply"], description: "Engagement type." },
    replyBody: { type: "string", maxLength: 10_000, description: "Reply body for a reply engagement." },
  }, ["postId", "engagement"]],
] as const;
