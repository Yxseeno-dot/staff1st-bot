import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeExpiredActionReply, shiftSaveIdentity } from "../src/domain.js";

test("save identities are stable per workflow proposal and unique between proposals", () => {
  const workflow = "11111111-1111-4111-8111-111111111111";
  const first = shiftSaveIdentity(workflow, "22222222-2222-4222-8222-222222222222");
  const replay = shiftSaveIdentity(workflow, "22222222-2222-4222-8222-222222222222");
  const second = shiftSaveIdentity(workflow, "33333333-3333-4333-8333-333333333333");
  assert.deepEqual(replay, first);
  assert.notEqual(second.idempotency_key, first.idempotency_key);
});

test("invalid save identities are rejected before reaching the API", () => {
  assert.throws(() => shiftSaveIdentity("workflow", "proposal"));
});

test("expired action replies are distinguished from fresh shift offers", () => {
  assert.equal(looksLikeExpiredActionReply("yes"), true);
  assert.equal(looksLikeExpiredActionReply("1, 3"), true);
  assert.equal(looksLikeExpiredActionReply("all"), true);
  assert.equal(looksLikeExpiredActionReply("22 August at Boots, 9-5, £32/hr"), false);
  assert.equal(looksLikeExpiredActionReply("New shift tomorrow at M9 8DX"), false);
});
