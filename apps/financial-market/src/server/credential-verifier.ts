import {
  createMcpBearerVerifier,
  experimentCredentialIssuer,
} from "@openleek/experiment-credentials";
import type {
  FinancialMcpCredentialClaims,
  FinancialMcpCredentialVerifier,
} from "../application/revision-service";

/**
 * Financial owns a public-key-only verifier.  Experiment is the sole holder
 * of the private signing key; bearer tokens are never stored by this Context.
 */
export function financialMcpCredentialVerifierFromEnvironment(): FinancialMcpCredentialVerifier {
  const kid = required("OPENLEEK_EXPERIMENT_CREDENTIAL_KID");
  const publicKey = required("OPENLEEK_EXPERIMENT_CREDENTIAL_PUBLIC_KEY").replace(/\\n/g, "\n");
  const configuredIssuer = process.env.OPENLEEK_EXPERIMENT_CREDENTIAL_ISSUER;
  if (configuredIssuer !== undefined && configuredIssuer !== experimentCredentialIssuer) {
    throw new Error(`OPENLEEK_EXPERIMENT_CREDENTIAL_ISSUER must be ${experimentCredentialIssuer}`);
  }
  const verifier = createMcpBearerVerifier({
    publicKeys: [{ kid, publicKey }],
    ...(configuredIssuer === undefined ? {} : { issuer: experimentCredentialIssuer }),
  });
  return {
    async verifyBearer(token: string): Promise<FinancialMcpCredentialClaims> {
      const claims = verifier.verifyMcpBearer({ token, audience: "financial" });
      return { ...claims, audience: "financial" };
    },
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Financial MCP bearer verification`);
  return value;
}
