import assert from "node:assert/strict";
import test from "node:test";
import { GET as health } from "../src/app/health/route.js";
import { GET as ready } from "../src/app/ready/route.js";
import { resetSocialEnvironmentRuntimeForTest } from "../src/server/runtime.js";

test("health endpoint is Node runtime and does not initialize persistence", async () => {
  const previous = process.env.OPENLEEK_SOCIAL_ENVIRONMENT_WORKER;
  process.env.OPENLEEK_SOCIAL_ENVIRONMENT_WORKER = "true";
  try {
    const response = health();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "social-environment" });
    assert.equal((globalThis as { __openleekSocialEnvironmentWorker?: unknown }).__openleekSocialEnvironmentWorker, undefined);
  } finally {
    restore("OPENLEEK_SOCIAL_ENVIRONMENT_WORKER", previous);
  }
});

test("ready endpoint reports unavailable Social-owned configuration safely", async () => {
  const previous = {
    database: process.env.OPENLEEK_SOCIAL_ENVIRONMENT_DATABASE_URL,
    uri: process.env.OPENLEEK_SOCIAL_NEO4J_URI,
    user: process.env.OPENLEEK_SOCIAL_NEO4J_USER,
    password: process.env.OPENLEEK_SOCIAL_NEO4J_PASSWORD,
  };
  delete process.env.OPENLEEK_SOCIAL_ENVIRONMENT_DATABASE_URL;
  delete process.env.OPENLEEK_SOCIAL_NEO4J_URI;
  delete process.env.OPENLEEK_SOCIAL_NEO4J_USER;
  delete process.env.OPENLEEK_SOCIAL_NEO4J_PASSWORD;
  resetSocialEnvironmentRuntimeForTest();
  try {
    const response = await ready();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "not_ready",
      message: "OPENLEEK_SOCIAL_ENVIRONMENT_DATABASE_URL is required",
    });
  } finally {
    restore("OPENLEEK_SOCIAL_ENVIRONMENT_DATABASE_URL", previous.database);
    restore("OPENLEEK_SOCIAL_NEO4J_URI", previous.uri);
    restore("OPENLEEK_SOCIAL_NEO4J_USER", previous.user);
    restore("OPENLEEK_SOCIAL_NEO4J_PASSWORD", previous.password);
    resetSocialEnvironmentRuntimeForTest();
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
