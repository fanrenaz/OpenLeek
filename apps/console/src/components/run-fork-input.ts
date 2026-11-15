export function forkManifestBinding(sourceManifestRef: string) {
  return {
    expectedManifestRef: sourceManifestRef,
    sourceManifestRef,
  };
}
