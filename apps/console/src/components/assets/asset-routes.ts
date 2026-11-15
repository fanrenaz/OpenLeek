export type AssetLocation =
  | { kind: "library"; basePath: string }
  | { kind: "new"; basePath: string }
  | { kind: "draft"; basePath: string; id: string }
  | { kind: "version"; basePath: string; id: string };

const trimTrailingSlash = (value: string) => value.length > 1 ? value.replace(/\/$/, "") : value;

const decodeSegment = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function parseAssetPathname(pathname: string): AssetLocation {
  const normalized = trimTrailingSlash(pathname);
  const segments = normalized.split("/").filter(Boolean);
  const last = segments.at(-1);
  const parent = segments.at(-2);

  if (last === "new") {
    return { kind: "new", basePath: `/${segments.slice(0, -1).join("/")}` };
  }
  if ((parent === "drafts" || parent === "versions") && last) {
    return {
      kind: parent === "drafts" ? "draft" : "version",
      basePath: `/${segments.slice(0, -2).join("/")}`,
      id: decodeSegment(last),
    };
  }
  return { kind: "library", basePath: normalized };
}

export const assetNewHref = (basePath: string, versionRef?: string) =>
  versionRef
    ? `${trimTrailingSlash(basePath)}/new?fromVersion=${encodeURIComponent(versionRef)}`
    : `${trimTrailingSlash(basePath)}/new`;

export const assetDraftHref = (basePath: string, draftId: string) =>
  `${trimTrailingSlash(basePath)}/drafts/${encodeURIComponent(draftId)}`;

export const assetVersionHref = (basePath: string, versionRef: string) =>
  `${trimTrailingSlash(basePath)}/versions/${encodeURIComponent(versionRef)}`;

export const isAssetRouteSegments = (segments: string[]) =>
  (segments.length === 1 && segments[0] === "new") ||
  (segments.length === 2 && (segments[0] === "drafts" || segments[0] === "versions") && Boolean(segments[1]));
