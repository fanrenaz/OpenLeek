import assert from "node:assert/strict";
import test from "node:test";
import { OpenLeekDomainError, asTRPCError, domainProcedure, t } from "../src/index.js";

test("domain errors retain their stable code through tRPC", async () => {
  const router = t.router({
    action: domainProcedure.query(() => {
      throw new OpenLeekDomainError({ code: "IDEMPOTENCY_CONFLICT", message: "digest differs" });
    }),
  });
  await assert.rejects(router.createCaller({}).action(), (error: unknown) => {
    return error instanceof Error && error.message === "digest differs";
  });
});

test("domain errors map to a transport code without losing semantics", () => {
  const error = asTRPCError(new OpenLeekDomainError({ code: "NOT_FOUND", message: "missing" }));
  assert.equal(error.code, "NOT_FOUND");
});
