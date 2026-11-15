import { createMcpBearerVerifier } from "@openleek/experiment-credentials";

/**
 * Verifies the Experiment-issued bearer used by Social's MCP HTTP endpoint.
 * This Context receives public key material only; signing remains Experiment's
 * responsibility.
 */
export function verifySocialMcpBearer(
  token: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const kid = environment.OPENLEEK_EXPERIMENT_CREDENTIAL_KID;
  const publicKey = environment.OPENLEEK_EXPERIMENT_CREDENTIAL_PUBLIC_KEY?.replace(/\\n/g, "\n");
  if (!kid || !publicKey) throw new Error("Social MCP Experiment credential verifier is not configured");
  return createMcpBearerVerifier({ publicKeys: [{ kid, publicKey }] }).verifyMcpBearer({ token, audience: "social" });
}
