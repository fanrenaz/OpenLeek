import assert from "node:assert/strict";
import test from "node:test";
import {
  assetDraftHref,
  assetNewHref,
  assetVersionHref,
  isAssetRouteSegments,
  parseAssetPathname,
} from "../src/components/assets/asset-routes";

const basePath = "/assets/global/feed-algorithms";

test("asset route helpers encode identifiers into one path segment", () => {
  assert.equal(
    assetDraftHref(basePath, "feed-algorithm:abc"),
    `${basePath}/drafts/feed-algorithm%3Aabc`,
  );
  assert.equal(
    assetVersionHref(basePath, "feed-algorithm:abc:v1"),
    `${basePath}/versions/feed-algorithm%3Aabc%3Av1`,
  );
  assert.equal(
    assetNewHref(basePath, "feed-algorithm:abc:v1"),
    `${basePath}/new?fromVersion=feed-algorithm%3Aabc%3Av1`,
  );
});

test("asset path parser restores route meaning and decoded identifiers", () => {
  assert.deepEqual(parseAssetPathname(basePath), { kind: "library", basePath });
  assert.deepEqual(parseAssetPathname(`${basePath}/new`), { kind: "new", basePath });
  assert.deepEqual(parseAssetPathname(`${basePath}/drafts/feed-algorithm%3Aabc`), {
    kind: "draft",
    basePath,
    id: "feed-algorithm:abc",
  });
  assert.deepEqual(parseAssetPathname(`${basePath}/versions/feed-algorithm%3Aabc%3Av1`), {
    kind: "version",
    basePath,
    id: "feed-algorithm:abc:v1",
  });
});

test("catch-all asset routes reject unsupported shapes", () => {
  assert.equal(isAssetRouteSegments(["new"]), true);
  assert.equal(isAssetRouteSegments(["drafts", "profile:abc"]), true);
  assert.equal(isAssetRouteSegments(["versions", "profile:abc:v1"]), true);
  assert.equal(isAssetRouteSegments(["edit"]), false);
  assert.equal(isAssetRouteSegments(["drafts"]), false);
  assert.equal(isAssetRouteSegments(["versions", "a", "extra"]), false);
});
