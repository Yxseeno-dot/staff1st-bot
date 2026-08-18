# Future-proofing Staff1st Bot and Locum1st iOS

**Prepared:** 18 August 2026

**Related:** [IOS_APP_HANDOFF.md](./IOS_APP_HANDOFF.md)

## Goal

Allow the bot, API, and iOS app to evolve independently without breaking active conversations, duplicating shifts, or requiring a new custom iOS interface for every bot workflow.

The target architecture treats the bot as a client of a versioned platform API. Conversation text remains useful as a universal fallback, while structured contracts drive native UI and reliable data changes.

## Design principles

1. Contracts are explicit, versioned, and backward-compatible.
2. Display text is never used as an identifier or parsed to recover business data.
3. Data-changing operations are idempotent.
4. Workflow state survives restarts, deployments, and multiple bot instances.
5. Stated, inferred, assumed, suggested, and calculated values remain distinguishable.
6. Older apps can always fall back to readable text and free-text replies.
7. The server, rather than iOS or the LLM, owns business rules and validation.

## 1. Version the message contract

Every actionable bot message should declare a schema version. Unknown versions and actions must decode safely in iOS.

```json
{
  "schemaVersion": 1,
  "action": {
    "type": "choose",
    "selectionMode": "single",
    "options": []
  }
}
```

Compatibility rules:

- Additive optional properties are allowed within a version.
- Renamed, removed, or behavior-changing properties require a new version.
- iOS displays the message text and composer when it cannot render an action.
- The server retains support for active older app versions during a documented migration window.

## 2. Replace workflow-specific actions with generic actions

Current actions such as `select_dates`, `select_pharmacy`, and `select_delete` should converge on a reusable choice model.

```json
{
  "schemaVersion": 2,
  "action": {
    "id": "action_01JXYZ",
    "type": "choose",
    "selectionMode": "multiple",
    "prompt": "Which shifts do you want to log?",
    "options": [
      {
        "id": "proposal_01JABC",
        "title": "Monday 24 August, 09:00–17:00",
        "subtitle": "Example Pharmacy"
      }
    ],
    "allowNone": true,
    "expiresAt": "2026-08-19T12:00:00Z"
  }
}
```

Replies should contain stable identifiers:

```json
{
  "actionId": "action_01JXYZ",
  "selectedOptionIds": ["proposal_01JABC"]
}
```

Never use list position or visible labels as identity. Labels may be reordered, localized, or reformatted.

## 3. Persist workflow state

Replace process-local conversation state with a server-side workflow record containing:

- Workflow ID and schema version
- User and conversation IDs
- Current step
- Pending shift proposals
- Action IDs and allowed replies
- Creation, update, and expiry timestamps
- Completion/cancellation status
- Idempotency keys and resulting resource IDs

The update path should use a transaction or optimistic concurrency token so two replies cannot advance the same workflow twice.

Expired or completed actions should produce a clear, non-destructive response. A fresh shift message must not be mistaken for a reply to an old action.

## 4. Make all writes idempotent

Give every proposed shift a stable `proposalId`. Shift creation should accept an idempotency key derived from the workflow and proposal, for example:

```text
workflow_01JXYZ:proposal_01JABC:save
```

Repeated requests return the original result instead of creating another shift. Apply the same rule to deletion and batch operations where retries are possible.

For batch saves, return an itemized result so partial success can be retried safely:

```json
{
  "results": [
    {
      "proposalId": "proposal_01JABC",
      "status": "created",
      "shiftId": "shift_01JDEF"
    }
  ]
}
```

## 5. Preserve meaning and provenance

Do not collapse different concepts into the same stored field. Travel compensation should become a tagged model:

```json
{
  "travelCompensation": {
    "type": "paid_hours",
    "hours": 2,
    "hourlyRate": 32,
    "hourlyRateProvenance": "assumed_shift_rate",
    "calculatedAmount": 64
  }
}
```

Suggested compensation types:

- `none`
- `per_mile`
- `fixed_allowance`
- `paid_hours`

Suggested provenance values:

- `stated`
- `inferred`
- `assumed`
- `suggested`
- `calculated`

Keep existing flat fields during migration. The API can populate both representations until all supported clients understand the structured model.

## 6. Separate structured analysis from presentation

Bot markdown should remain available, but application logic must use structured data.

```json
{
  "summaryMarkdown": "**SHIFT SUMMARY** …",
  "analysis": {
    "role": "pharmacy_technician",
    "rate": {
      "offered": 18,
      "benchmark": 17,
      "verdict": "worth_taking"
    },
    "distance": {
      "oneWayMiles": 12.4,
      "durationMinutes": 26
    },
    "assumptions": [
      {
        "code": "mileage_rate_defaulted",
        "message": "Mileage rate assumed to be 55p per mile."
      }
    ]
  }
}
```

iOS may render native cards from `analysis`. Unsupported or older clients render `summaryMarkdown`.

## 7. Use structured locations

Do not make iOS recover a postcode by splitting an address string.

```json
{
  "location": {
    "displayAddress": "12 High Street, Ashbourne, DE6 1AA",
    "line1": "12 High Street",
    "city": "Ashbourne",
    "postcode": "DE6 1AA",
    "latitude": 53.016,
    "longitude": -1.731,
    "pharmacyOdsCode": "F1234",
    "resolution": "ods_match"
  }
}
```

Coordinates should be stored when a trusted pharmacy or geocoding result is available. `displayAddress` remains useful for presentation, but is not the canonical source for individual fields.

## 8. Publish one shared contract

Maintain JSON Schema or OpenAPI definitions for:

- Conversation messages and actions
- Action replies
- Shift proposals
- Analysis results
- Saved shifts
- Travel compensation
- Locations
- Error responses

Generate TypeScript types and Swift `Codable` models where practical. At minimum, validate fixtures and runtime server output against the same schema in CI.

Contract changes should include:

- A schema diff
- Backward-compatibility assessment
- Type regeneration or manual model updates
- Fixture updates
- Bot, API, and iOS contract tests

## 9. Add capability negotiation

The app should advertise its supported contract versions and optional features at session registration or conversation fetch:

```json
{
  "messageSchemaVersions": [1, 2],
  "capabilities": [
    "generic_choice_actions",
    "structured_shift_analysis",
    "travel_compensation_v2"
  ]
}
```

The server emits the newest compatible response. If no native action is compatible, it sends a text prompt that can be answered through the composer.

Capability negotiation is preferable to checking app version strings because it describes behavior directly.

## 10. Testing strategy

### Contract tests

- Every server fixture validates against the published schema.
- Swift decodes every supported fixture.
- Swift safely handles an unknown optional field and unknown action type.
- Old schema fixtures remain valid throughout the support window.

### Workflow tests

- A workflow resumes after bot restart.
- Two bot instances cannot process the same reply twice.
- A duplicate save returns the original shift.
- An expired or already-completed action cannot mutate data.
- A new offer is not consumed as a stale action reply.
- Batch partial failures can be retried without duplicates.

### End-to-end tests

- Ambiguous and unmatched pharmacies
- Single and multiple shift proposals
- Historical, future, overnight, and London date-boundary cases
- Every supported role
- Stated and assumed rates
- Per-mile, fixed, and paid-hours travel compensation
- Old iOS capability set receiving a safe fallback

## Phased delivery plan

### Phase 1 — Operational safety

1. Add idempotency to shift saves.
2. Persist workflows outside bot memory.
3. Make iOS unknown-action decoding non-fatal with a text fallback.
4. Add restart, duplicate-reply, and duplicate-save tests.

This phase removes the largest data-loss and duplication risks without changing the visible experience.

### Phase 2 — Versioned generic actions

1. Publish message schema v2.
2. Add stable action and option IDs.
3. Implement the generic choice component in iOS.
4. Add capability negotiation.
5. Dual-emit or translate legacy actions during migration.

### Phase 3 — Rich domain models

1. Add structured location and coordinates.
2. Add structured travel compensation and provenance.
3. Return structured shift analysis with markdown fallback.
4. Migrate iOS screens to native structured rendering.
5. Retire legacy fields only after supported clients have migrated.

## Definition of done

- A bot deployment or restart does not lose an active workflow.
- Replaying any data-changing request cannot create duplicate resources.
- The latest iOS app renders native actions, while an older app completes the same workflow through text.
- Unknown actions and additive fields never break message decoding.
- No business field is extracted from markdown or a display label.
- Travel compensation and other assumptions retain their original meaning and provenance.
- Bot, API, and iOS CI validate shared fixtures before release.
