import assert from "node:assert/strict";
import test from "node:test";
import { createExperimentCredentialSigner, generateExperimentCredentialKeyPair } from "@openleek/experiment-credentials";
import { financialMcpCredentialVerifierFromEnvironment } from "../src/server/credential-verifier.js";

test("Financial verifies Experiment-issued JWS bearer credentials against its local public key", async () => {
  const previousKid = process.env.OPENLEEK_EXPERIMENT_CREDENTIAL_KID;
  const previousPublicKey = process.env.OPENLEEK_EXPERIMENT_CREDENTIAL_PUBLIC_KEY;
  const keyPair = generateExperimentCredentialKeyPair();
  process.env.OPENLEEK_EXPERIMENT_CREDENTIAL_KID = "financial-test-key";
  process.env.OPENLEEK_EXPERIMENT_CREDENTIAL_PUBLIC_KEY = keyPair.publicKeyPem;
  try {
    const signer = createExperimentCredentialSigner({ kid: "financial-test-key", privateKey: keyPair.privateKeyPem, nowUnixSeconds: () => 1_700_000_000 });
    const verifier = financialMcpCredentialVerifierFromEnvironment();
    const token = signer.issue({
      principalId: "principal:run:credential:agent:buyer",
      runId: "run:credential",
      agentId: "agent:buyer",
      audience: "financial",
      credentialVersion: 1,
    });
    assert.deepEqual(await verifier.verifyBearer(token), {
      principalId: "principal:run:credential:agent:buyer",
      runId: "run:credential",
      agentId: "agent:buyer",
      audience: "financial",
      credentialVersion: 1,
      issuedAt: 1_700_000_000,
    });
    await assert.rejects(() => verifier.verifyBearer(`${token}tampered`));
  } finally {
    if (previousKid === undefined) delete process.env.OPENLEEK_EXPERIMENT_CREDENTIAL_KID;
    else process.env.OPENLEEK_EXPERIMENT_CREDENTIAL_KID = previousKid;
    if (previousPublicKey === undefined) delete process.env.OPENLEEK_EXPERIMENT_CREDENTIAL_PUBLIC_KEY;
    else process.env.OPENLEEK_EXPERIMENT_CREDENTIAL_PUBLIC_KEY = previousPublicKey;
  }
});
