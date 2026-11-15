import assert from "node:assert/strict";
import test from "node:test";
import { forkManifestBinding } from "../src/components/run-fork-input.js";

test("a Console fork binds concurrency to the selected historical manifest", () => {
  const selectedManifestRef = "manifest:run:source:round:5";
  assert.deepEqual(forkManifestBinding(selectedManifestRef), {
    expectedManifestRef: selectedManifestRef,
    sourceManifestRef: selectedManifestRef,
  });
});
