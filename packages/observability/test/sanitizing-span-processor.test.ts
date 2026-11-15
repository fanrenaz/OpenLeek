import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeSpan } from "../src/sanitizing-span-processor";

test("sanitizeSpan keeps only diagnostic allowlisted facts", () => {
  const span = {
    attributes: {
      "http.request.method": "POST",
      "http.response.status_code": 500,
      "openleek.run_id": "run-1",
      "url.full": "https://example.test/path?token=secret-sentinel",
      "db.query.text": "select secret_sentinel",
      "exception.message": "secret-sentinel",
    },
    events: [{ name: "exception", time: [0, 0] as [number, number], attributes: { "exception.stacktrace": "secret-sentinel" } }],
    status: { code: 2, message: "secret-sentinel" },
  };

  sanitizeSpan(span);

  assert.deepEqual(span.attributes, {
    "http.request.method": "POST",
    "http.response.status_code": 500,
    "openleek.run_id": "run-1",
  });
  assert.deepEqual(span.events, []);
  assert.deepEqual(span.status, { code: 2 });
});
