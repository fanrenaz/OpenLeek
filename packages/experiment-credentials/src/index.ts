import { generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/** A registered Context ID is the credential audience; business meaning stays Context-owned. */
export type ExperimentCredentialAudience = string;

export const experimentCredentialIssuer = "openleek-experiment";

/**
 * The signed identity envelope. Dynamic authorization (round, turn, revision,
 * actor/account and expiry) intentionally stays in a Context-owned MCP scope.
 */
export interface ExperimentCredentialClaims {
  iss: typeof experimentCredentialIssuer;
  sub: string;
  aud: ExperimentCredentialAudience;
  runId: string;
  agentId: string;
  credentialVersion: number;
  iat: number;
}

export interface ExperimentCredentialIssueInput {
  principalId: string;
  runId: string;
  agentId: string;
  audience: ExperimentCredentialAudience;
  credentialVersion: number;
}

export type ExperimentCredentialKeyMaterial = string | Buffer | KeyObject;

export interface ExperimentCredentialSigner {
  readonly kid: string;
  issue(input: ExperimentCredentialIssueInput): string;
}

export interface ExperimentCredentialPublicKey {
  kid: string;
  publicKey: ExperimentCredentialKeyMaterial;
}

export interface VerifyExperimentCredentialInput {
  publicKeys: readonly ExperimentCredentialPublicKey[];
  audience: ExperimentCredentialAudience;
  issuer?: typeof experimentCredentialIssuer;
}

/** The Context-facing identity derived from a validated MCP bearer token. */
export interface McpBearerIdentity {
  principalId: string;
  runId: string;
  agentId: string;
  audience: ExperimentCredentialAudience;
  credentialVersion: number;
  issuedAt: number;
}

/** A deliberately non-sensitive error for Context MCP authentication failures. */
export class ExperimentCredentialVerificationError extends Error {
  constructor(message = "invalid Experiment credential") {
    super(message);
    this.name = "ExperimentCredentialVerificationError";
  }
}

/**
 * Creates a compact Ed25519 JWS signer. `nowUnixSeconds` exists so tests can
 * make the immutable signed claims deterministic; production callers omit it.
 */
export function createExperimentCredentialSigner(input: {
  kid: string;
  privateKey: ExperimentCredentialKeyMaterial;
  issuer?: typeof experimentCredentialIssuer;
  nowUnixSeconds?: () => number;
}): ExperimentCredentialSigner {
  requireIdentifier(input.kid, "kid");
  const issuer = input.issuer ?? experimentCredentialIssuer;
  const now = input.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1_000));
  return {
    kid: input.kid,
    issue(issue) {
      validateIssueInput(issue);
      const claims: ExperimentCredentialClaims = {
        iss: issuer,
        sub: issue.principalId,
        aud: issue.audience,
        runId: issue.runId,
        agentId: issue.agentId,
        credentialVersion: issue.credentialVersion,
        iat: now(),
      };
      validateClaims(claims, issuer);
      const header = { alg: "EdDSA", kid: input.kid, typ: "JWS" };
      const protectedHeader = encodeJson(header);
      const payload = encodeJson(claims);
      const signingInput = `${protectedHeader}.${payload}`;
      const signature = sign(null, Buffer.from(signingInput, "utf8"), input.privateKey).toString("base64url");
      return `${signingInput}.${signature}`;
    },
  };
}

/**
 * Verifies a compact Ed25519 JWS against the Context's local Experiment
 * public-key keyring. It never calls Experiment and intentionally does not
 * interpret resource permissions.
 */
export function verifyExperimentCredential(token: string, input: VerifyExperimentCredentialInput): ExperimentCredentialClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !isBase64Url(part))) throw new ExperimentCredentialVerificationError();
  const [protectedHeader, payload, encodedSignature] = parts as [string, string, string];
  const header = decodeJson(protectedHeader);
  if (!isRecord(header) || header.alg !== "EdDSA" || typeof header.kid !== "string" || !header.kid || (header.typ !== undefined && header.typ !== "JWS")) {
    throw new ExperimentCredentialVerificationError();
  }
  const key = input.publicKeys.find((candidate) => candidate.kid === header.kid);
  if (!key) throw new ExperimentCredentialVerificationError();
  const signature = Buffer.from(encodedSignature, "base64url");
  try {
    if (!verify(null, Buffer.from(`${protectedHeader}.${payload}`, "utf8"), key.publicKey, signature)) {
      throw new ExperimentCredentialVerificationError();
    }
  } catch (error) {
    if (error instanceof ExperimentCredentialVerificationError) throw error;
    throw new ExperimentCredentialVerificationError();
  }
  const claims = decodeJson(payload);
  if (!isRecord(claims)) throw new ExperimentCredentialVerificationError();
  validateClaims(claims, input.issuer ?? experimentCredentialIssuer);
  if (claims.aud !== input.audience) throw new ExperimentCredentialVerificationError();
  return claims;
}

/**
 * Creates the narrow verifier shape used by Context MCP HTTP endpoints. Key
 * material is configured once in the owning Context; each request supplies
 * only the bearer token and the endpoint's fixed audience.
 */
export function createMcpBearerVerifier(input: {
  publicKeys: readonly ExperimentCredentialPublicKey[];
  issuer?: typeof experimentCredentialIssuer;
}): { verifyMcpBearer(input: { token: string; audience: ExperimentCredentialAudience }): McpBearerIdentity } {
  return {
    verifyMcpBearer(request) {
      const claims = verifyExperimentCredential(request.token, {
        publicKeys: input.publicKeys,
        audience: request.audience,
        ...(input.issuer ? { issuer: input.issuer } : {}),
      });
      return {
        principalId: claims.sub,
        runId: claims.runId,
        agentId: claims.agentId,
        audience: claims.aud,
        credentialVersion: claims.credentialVersion,
        issuedAt: claims.iat,
      };
    },
  };
}

/** Convenient development/test key generation. Store the private PEM only in Experiment. */
export function generateExperimentCredentialKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function validateIssueInput(value: ExperimentCredentialIssueInput): void {
  requireIdentifier(value.principalId, "principalId");
  requireIdentifier(value.runId, "runId");
  requireIdentifier(value.agentId, "agentId");
  requireIdentifier(value.audience, "audience");
  if (!Number.isSafeInteger(value.credentialVersion) || value.credentialVersion < 1) throw new Error("credentialVersion must be a positive integer");
}

function validateClaims(value: unknown, expectedIssuer: string): asserts value is ExperimentCredentialClaims {
  if (!isRecord(value)
    || value.iss !== expectedIssuer
    || typeof value.sub !== "string" || !value.sub
    || typeof value.aud !== "string" || !value.aud || value.aud.length > 8_192
    || typeof value.runId !== "string" || !value.runId
    || typeof value.agentId !== "string" || !value.agentId
    || typeof value.credentialVersion !== "number" || !Number.isSafeInteger(value.credentialVersion) || value.credentialVersion < 1
    || typeof value.iat !== "number" || !Number.isSafeInteger(value.iat) || value.iat < 0) {
    throw new ExperimentCredentialVerificationError();
  }
}

function requireIdentifier(value: string, name: string): void {
  // Experiment derives principal IDs from run and agent IDs, each of which can
  // carry a namespaced prefix. This package validates presence, not a domain
  // schema's shorter storage limit.
  if (!value || value.length > 8_192) throw new Error(`${name} must be a non-empty identifier`);
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new ExperimentCredentialVerificationError();
  }
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
