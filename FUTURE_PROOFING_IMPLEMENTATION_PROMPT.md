# Implementation prompt: future-proof Staff1st Bot and Locum1st iOS

Copy the prompt below into a coding-agent session opened at `/home/ubuntu/1stAppSuite`.

---

You are working across the Staff1st bot, the Locum1st API, and the Locum1st iOS app.

Read these documents first:

- `/home/ubuntu/1stAppSuite/Staff1stBot/IOS_APP_HANDOFF.md`
- `/home/ubuntu/1stAppSuite/Staff1stBot/FUTURE_PROOFING_PLAN.md`
- Every applicable `AGENTS.md` in each repository before inspecting or editing code

## Objective

Implement Phase 1 of the future-proofing plan:

1. Persist Staff1st conversation workflows outside process memory.
2. Make bot-triggered shift creation idempotent.
3. Make Locum1st iOS safely fall back to message text and free-text input for unknown or unsupported action types.
4. Add focused automated tests for restarts, duplicate replies, duplicate saves, expired workflows, and unknown iOS actions.

Do not implement Phase 2 generic actions or Phase 3 domain-model redesign in this task. Design Phase 1 so those changes can be added later without another state-storage migration.

## Required discovery

Before changing code:

1. Inspect the git status of every repository you will touch. Preserve unrelated user changes.
2. Trace the complete path from an incoming conversation message through bot state handling to `/save-shift` and the database write.
3. Identify existing database migration conventions, transaction helpers, authentication boundaries, retry behavior, and test frameworks.
4. Trace iOS message decoding, actionable-message selection, reply submission, and post-save refresh behavior.
5. Write a short implementation plan naming the files and contracts to change.

Do not assume the structures described below already exist. Reuse established project conventions where they are safer or more consistent.

## Functional requirements

### Persistent workflows

Store at least:

- A stable workflow ID
- Workflow schema version
- Conversation ID and authenticated user ID
- Current phase/step
- JSON payload for pending proposals and step-specific state
- Status: active, completed, cancelled, or expired
- Created, updated, and expiry timestamps
- A concurrency/version value

Requirements:

- Active workflows survive bot restarts and can be handled by any bot instance.
- Workflow reads and updates are scoped to both conversation and authenticated user.
- State transitions are atomic or use optimistic concurrency.
- Two concurrent replies cannot complete the same action twice.
- Completed and expired workflows cannot cause writes.
- Expired state produces a clear message asking the user to resend the offer.
- A fresh offer must not be swallowed as an invalid reply to stale state.
- Do not persist secrets or unnecessary raw personal data.
- Add an explicit retention/cleanup strategy for terminal and expired records.

Use a versioned JSON payload for phase-specific state so future action schemas can be introduced without redesigning the table.

### Idempotent shift saves

Assign each pending shift proposal a stable proposal ID. The save operation must accept a stable idempotency key derived from the workflow and proposal rather than from display text or list position.

Requirements:

- Repeating the same save returns the original successful result and shift ID.
- It never creates a duplicate shift or duplicate auto-mileage record.
- Two simultaneous requests with the same key are safe.
- Different proposals in a batch have different keys.
- Partial batch failures can be retried without recreating successful items.
- The database enforces uniqueness; do not rely only on an in-process check.
- Idempotency records are scoped to the authenticated user and operation.
- Existing callers without a key remain backward-compatible unless the current API contract already permits making the field mandatory.

Prefer a transaction that couples the idempotency result with shift creation and any related mileage creation. If project architecture prevents one transaction, document the failure window and implement the safest available recovery behavior.

### iOS unknown-action fallback

Requirements:

- Unknown action strings and additive metadata fields must not fail decoding of the message or conversation.
- The message text remains visible.
- The normal composer remains available so a text-based fallback can be completed.
- Known actions continue to show their existing native controls.
- Only the latest valid actionable message receives controls.
- Do not treat an unknown action as permission for a data-changing operation.
- Add decoding and view-model tests for known and unknown actions.

Use a tolerant representation such as a raw string or an enum with an `unknown` case only if it fits existing Swift conventions.

## Data and API design constraints

- Introduce explicit schema/version fields for persisted workflow payloads.
- Use opaque stable IDs for workflows, proposals, and idempotency keys.
- Do not parse markdown, visible option labels, or option positions to identify a shift.
- Keep current `select_pharmacy`, `select_dates`, `select_delete`, and `confirm_shift` clients working.
- Do not remove or rename current API response fields in Phase 1.
- Validate all untrusted JSON before using it for a state transition or database write.
- Log workflow and proposal IDs for diagnosis, but do not log message bodies or secrets unnecessarily.

## Tests that must be added

At minimum, cover:

1. Create a pending workflow, construct a fresh bot/state service instance, and resume it successfully.
2. Submit the same confirmation twice and verify exactly one shift and one associated mileage effect.
3. Race two confirmations and verify exactly one logical completion.
4. Retry a partially successful multi-shift batch and verify successful shifts are not duplicated.
5. Reply to an expired workflow and verify no shift is created.
6. Send a fresh shift offer while stale state exists and verify it is analyzed as a new offer.
7. Decode an iOS message containing an unknown action and unknown metadata fields.
8. Verify that unknown-action message text and composer fallback remain available.
9. Verify all currently known actions retain their existing UI behavior.

Use deterministic clocks or injected time where expiry behavior is tested. Avoid sleeps and timing-sensitive tests.

## Verification

Run the narrowest relevant tests while iterating, then run the full test/typecheck/build commands appropriate to every touched project. Also run migration validation according to repository conventions.

Report:

- Files and contracts changed
- Database migration and rollback considerations
- Exact verification commands and results
- Backward-compatibility behavior
- Any remaining failure window or follow-up work

## Safety and scope

- Do not deploy, push, open a pull request, or alter production data.
- Do not edit unrelated dirty files.
- Do not weaken authentication, authorization, database constraints, or existing tests.
- Do not silently choose a destructive migration strategy.
- If the existing architecture makes a requirement unsafe or impossible, stop before that mutation and explain the evidence and smallest viable alternative.

## Completion criteria

The task is complete only when persistent state survives process replacement, duplicate/concurrent saves are database-safe, unsupported iOS actions degrade to a usable text flow, and the required automated tests pass.

---
