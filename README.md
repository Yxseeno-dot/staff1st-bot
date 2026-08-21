# Staff1stBot

Staff1stBot is the asynchronous messaging worker for Locum1st. It claims user
messages from PostgreSQL, runs the conversational shift workflows, stores the
reply transactionally, and publishes that stored reply through Centrifugo.

## Reliability model

- Messages are leased with `FOR UPDATE SKIP LOCKED`, so multiple worker
  processes can run without normally handling the same message concurrently.
- Workflow state is stored in `locum1st.bot_workflows`, survives restarts, and
  expires after ten minutes.
- Shift saves carry stable workflow/proposal idempotency keys. A retry therefore
  returns the prior result instead of creating another shift.
- Reply insertion, source-message completion, conversation preview updates, and
  outbox insertion share one database transaction.
- Centrifugo delivery uses `locum1st.bot_outbox`. Failed publishes retry with
  backoff, using the canonical stored message ID so clients can deduplicate.
- Calls to OpenAI and the Locum1st bot API are aborted when message processing
  times out.
- Shift offers are checked only against the user's booked Locum1st shifts;
  Staff1st rota data is intentionally outside the bot's calendar scope.
- Users can add shifts over several natural-language turns. Recent chat context
  is used to combine follow-up details, but saving still requires confirmation.
- Historical questions are answered from read-only Locum1st aggregates covering
  rates, estimated gross pay, hours, pharmacies, weekdays and monthly patterns.

## Deployment order

1. Deploy Locum1st first. Its startup migration (or
   `migrations/014_bot_reliability.sql`) creates the workflow, outbox, and lease
   schema required by this worker.
2. Confirm the Locum1st `/api/bot/save-shift` route accepts `workflow_id`,
   `proposal_id`, and `idempotency_key`.
3. Build and deploy Staff1stBot.
4. Check `/health` for liveness and `/ready` for database/poller readiness.

Do not deploy the worker before the Locum1st schema migration. The migration is
additive; rolling Staff1stBot back is safe, though old workers will not consume
the durable workflow or outbox tables.

## Local development

Copy `.env.example` to `.env` and set the required credentials, then run:

```sh
npm ci
npm run check
npm run dev
```

Production builds use:

```sh
npm run build
npm start
```

`npm run setup` still creates the bot user/conversations. It does not replace
the Locum1st migration.

## Operational checks

- A growing count of unpublished `bot_outbox` rows indicates a Centrifugo
  delivery problem; rows retry automatically.
- Old `bot_claimed_at` leases are recoverable and become eligible after the
  worker's lease timeout.
- Repeated partial batch saves are safe: successful proposals replay their
  stored idempotent result while unsuccessful proposals can be retried.
- Application logs intentionally use IDs and error metadata rather than message
  bodies or user identifiers.
