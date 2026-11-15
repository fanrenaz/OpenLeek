import assert from "node:assert/strict";
import test from "node:test";
import {
  ExperimentCredentialVerificationError,
  createMcpBearerVerifier,
  createExperimentCredentialSigner,
  generateExperimentCredentialKeyPair,
  verifyExperimentCredential,
} from "../src/index.js";

const keys = generateExperimentCredentialKeyPair();
const signer = createExperimentCredentialSigner({ kid: "test-1", privateKey: keys.privateKeyPem, nowUnixSeconds: () => 1_700_000_000 });

function issued(audience: string = "social") {
  return signer.issue({ principalId: "principal:run:test:agent:a", runId: "run:test", agentId: "agent:a", audience, credentialVersion: 1 });
}

test("signs and verifies an audience-isolated compact Ed25519 JWS", () => {
  const claims = verifyExperimentCredential(issued(), { audience: "social", publicKeys: [{ kid: "test-1", publicKey: keys.publicKeyPem }] });
  assert.deepEqual(claims, {
    iss: "openleek-experiment",
    sub: "principal:run:test:agent:a",
    aud: "social",
    runId: "run:test",
    agentId: "agent:a",
    credentialVersion: 1,
    iat: 1_700_000_000,
  });
});

test("supports a dynamically registered Context audience without weakening audience isolation", () => {
  const token = issued("news");
  const claims = verifyExperimentCredential(token, { audience: "news", publicKeys: [{ kid: "test-1", publicKey: keys.publicKeyPem }] });
  assert.equal(claims.aud, "news");
  assert.throws(
    () => verifyExperimentCredential(token, { audience: "social", publicKeys: [{ kid: "test-1", publicKey: keys.publicKeyPem }] }),
    ExperimentCredentialVerificationError,
  );
});

test("rejects mutation, unknown keys, and a wrong Context audience", () => {
  const token = issued();
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const tampered = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), aud: "financial" })).toString("base64url")}.${signature}`;
  const input = { audience: "social" as const, publicKeys: [{ kid: "test-1", publicKey: keys.publicKeyPem }] };
  assert.throws(() => verifyExperimentCredential(tampered, input), ExperimentCredentialVerificationError);
  assert.throws(() => verifyExperimentCredential(token, { ...input, publicKeys: [{ kid: "missing", publicKey: keys.publicKeyPem }] }), ExperimentCredentialVerificationError);
  assert.throws(() => verifyExperimentCredential(token, { ...input, audience: "financial" }), ExperimentCredentialVerificationError);
});

test("the MCP verifier exposes only the identity Contexts need for scope authorization", () => {
  const verifier = createMcpBearerVerifier({ publicKeys: [{ kid: "test-1", publicKey: keys.publicKeyPem }] });
  assert.deepEqual(verifier.verifyMcpBearer({ token: issued("financial"), audience: "financial" }), {
    principalId: "principal:run:test:agent:a",
    runId: "run:test",
    agentId: "agent:a",
    audience: "financial",
    credentialVersion: 1,
    issuedAt: 1_700_000_000,
  });
});
