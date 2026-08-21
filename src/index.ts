import "dotenv/config";
import * as Sentry from "@sentry/node";
import http from "http";
import { config } from "./config.js";
import { checkDatabase, closeDatabase, execute, query, queryOne, withTransaction, type DbClient } from "./db.js";
import { processMessage, type BotReply } from "./ai.js";
import { cleanupWorkflows } from "./workflows.js";

if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: process.env.NODE_ENV ?? "production",
    release: process.env.APP_VERSION,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request) delete event.request.data;
      return event;
    },
  });
}

type UnprocessedMessage = {
  id: string;
  conversation_id: string;
  text: string;
  user_id: string;
};

type OutboxItem = { id: string; channel: string; payload: unknown; attempts: number };

let activeJobs = 0;
let shuttingDown = false;
let lastPollAt: string | null = null;
let lastPollError: string | null = null;
const MIN_TYPING_MS = 900;
const PROCESS_TIMEOUT_MS = 45_000;
const PUBLISH_TIMEOUT_MS = 10_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publish(channel: string, data: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.centrifugoUrl}/api/publish`, {
      method: "POST",
      headers: { "X-API-Key": config.centrifugoApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ channel, data }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Centrifugo publish failed: ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

async function claimMessages(limit: number): Promise<UnprocessedMessage[]> {
  return withTransaction(async (client) => {
    const rows = await query<UnprocessedMessage>(
      `WITH candidates AS (
         SELECT m.id
         FROM locum1st.messages m
         JOIN locum1st.conversations c ON c.id = m.conversation_id
         WHERE m.bot_processed = false
           AND m.sender_id <> $1
           AND (c.participant_a = $1 OR c.participant_b = $1)
           AND (m.bot_claimed_at IS NULL OR m.bot_claimed_at < now() - interval '2 minutes')
           AND NOT EXISTS (
             SELECT 1 FROM locum1st.messages earlier
             WHERE earlier.conversation_id = m.conversation_id
               AND earlier.bot_processed = false
               AND earlier.sender_id <> $1
               AND (earlier.created_at, earlier.id) < (m.created_at, m.id)
           )
         ORDER BY m.created_at, m.id
         FOR UPDATE OF m SKIP LOCKED
         LIMIT $3
       )
       UPDATE locum1st.messages m
       SET bot_claimed_at = now(), bot_claimed_by = $2, bot_attempts = bot_attempts + 1
       FROM candidates x, locum1st.conversations c
       WHERE m.id = x.id AND c.id = m.conversation_id
       RETURNING m.id::text, m.conversation_id::text, m.text,
         CASE WHEN c.participant_a = $1 THEN c.participant_b ELSE c.participant_a END AS user_id`,
      [config.botUserId, config.workerId, limit],
      client
    );
    return rows;
  });
}

async function persistReply(msg: UnprocessedMessage, reply: BotReply) {
  return withTransaction(async (client) => {
    const stored = await queryOne<{
      id: string; conversation_id: string; sender_id: string; text: string;
      metadata: unknown; delivered_at: string | null; read_at: string | null; created_at: string;
    }>(
      `INSERT INTO locum1st.messages (conversation_id, sender_id, text, metadata, bot_processed)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id::text, conversation_id::text, sender_id, text, metadata,
         delivered_at::text, read_at::text, created_at::text`,
      [msg.conversation_id, config.botUserId, reply.text, reply.metadata ?? null],
      client
    );
    if (!stored) throw new Error("Bot reply insert returned no row");

    await execute(
      `UPDATE locum1st.conversations SET last_message_at = $2, last_message_preview = $3 WHERE id = $1`,
      [msg.conversation_id, stored.created_at, `Bot: ${reply.text.slice(0, 100)}`],
      client
    );
    await execute(
      `UPDATE locum1st.messages
       SET bot_processed = true, bot_claimed_at = NULL, bot_claimed_by = NULL
       WHERE id = $1 AND bot_claimed_by = $2`,
      [msg.id, config.workerId],
      client
    );
    if (reply.workflowStatus) {
      await execute(
        `UPDATE locum1st.bot_workflows
         SET status = $3, phase = 'idle', payload = '{"phase":"idle"}'::jsonb,
             updated_at = now(), version = version + 1
         WHERE conversation_id = $1 AND auth_user_id = $2 AND status = 'active'`,
        [msg.conversation_id, msg.user_id, reply.workflowStatus],
        client
      );
    }
    await execute(
      `INSERT INTO locum1st.bot_outbox (channel, payload) VALUES ($1, $2)`,
      [`conversation:${msg.conversation_id}`, JSON.stringify(stored)],
      client
    );
    return stored;
  });
}

async function handleMessage(msg: UnprocessedMessage) {
  const context = { conversationId: msg.conversation_id, messageId: msg.id };
  console.log("[message] processing", context);
  const channel = `conversation:${msg.conversation_id}`;
  const sendTyping = () => publish(channel, { type: "typing", senderId: config.botUserId }).catch(() => undefined);
  const startedAt = Date.now();
  sendTyping();
  const typingHeartbeat = setInterval(sendTyping, 3_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Processing timed out after ${PROCESS_TIMEOUT_MS}ms`)), PROCESS_TIMEOUT_MS);

  let reply: BotReply;
  try {
    reply = await processMessage(msg.conversation_id, msg.user_id, msg.text, msg.id, controller.signal);
  } catch (error) {
    console.error("[message] processing failed", context, error);
    Sentry.captureException(error, { contexts: { message: context } });
    reply = { text: "Sorry, I hit an error processing that. Please try again." };
  } finally {
    clearTimeout(timeout);
    clearInterval(typingHeartbeat);
  }

  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_TYPING_MS) await sleep(MIN_TYPING_MS - elapsed);
  const stored = await persistReply(msg, reply);
  console.log("[message] completed", { ...context, replyId: stored.id });
}

async function processAvailableMessages() {
  if (shuttingDown) return;
  const capacity = Math.max(0, config.workerConcurrency - activeJobs);
  if (!capacity) return;
  try {
    const messages = await claimMessages(capacity);
    lastPollAt = new Date().toISOString();
    lastPollError = null;
    for (const message of messages) {
      activeJobs++;
      void handleMessage(message)
        .catch(async (error) => {
          console.error("[message] handler failed", { conversationId: message.conversation_id, messageId: message.id }, error);
          Sentry.captureException(error);
          await execute(
            `UPDATE locum1st.messages SET bot_claimed_at = NULL, bot_claimed_by = NULL
             WHERE id = $1 AND bot_claimed_by = $2`,
            [message.id, config.workerId]
          ).catch(() => undefined);
        })
        .finally(() => { activeJobs--; });
    }
  } catch (error) {
    lastPollError = error instanceof Error ? error.message : "Unknown poll error";
    console.error("[poll] failed", error);
    Sentry.captureException(error);
  }
}

async function claimOutbox(limit = 20): Promise<OutboxItem[]> {
  return withTransaction(async (client: DbClient) => query<OutboxItem>(
    `WITH candidates AS (
       SELECT id FROM locum1st.bot_outbox
       WHERE published_at IS NULL AND available_at <= now()
         AND (claimed_at IS NULL OR claimed_at < now() - interval '1 minute')
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2
     )
     UPDATE locum1st.bot_outbox o
     SET claimed_at = now(), claimed_by = $1, attempts = attempts + 1
     FROM candidates c WHERE o.id = c.id
     RETURNING o.id::text, o.channel, o.payload, o.attempts`,
    [config.workerId, limit],
    client
  ));
}

async function flushOutbox() {
  if (shuttingDown) return;
  const items = await claimOutbox().catch((error) => {
    console.error("[outbox] claim failed", error);
    return [] as OutboxItem[];
  });
  for (const item of items) {
    try {
      await publish(item.channel, item.payload);
      await execute(`UPDATE locum1st.bot_outbox SET published_at = now(), claimed_at = NULL, claimed_by = NULL, last_error = NULL WHERE id = $1`, [item.id]);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Publish failed";
      const backoffSeconds = Math.min(300, 2 ** Math.min(item.attempts, 8));
      await execute(
        `UPDATE locum1st.bot_outbox SET claimed_at = NULL, claimed_by = NULL, last_error = $2,
           available_at = now() + ($3 * interval '1 second') WHERE id = $1`,
        [item.id, message, backoffSeconds]
      );
    }
  }
}

function startHealthServer() {
  return http.createServer(async (req, res) => {
    if (req.url !== "/health" && req.url !== "/ready") {
      res.writeHead(404).end();
      return;
    }
    const database = await checkDatabase();
    const ready = database && !shuttingDown && !lastPollError;
    const status = req.url === "/ready" && !ready ? 503 : 200;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: ready ? "ok" : "degraded", database, activeJobs, lastPollAt }));
  }).listen(config.port, () => console.log(`[Staff1stBot] Health server on :${config.port}`));
}

async function main() {
  console.log("[Staff1stBot] Starting", { workerId: config.workerId, concurrency: config.workerConcurrency });
  const server = startHealthServer();
  await processAvailableMessages();
  await flushOutbox();
  const pollTimer = setInterval(() => void processAvailableMessages(), config.pollIntervalMs);
  const outboxTimer = setInterval(() => void flushOutbox(), 1_000);
  const cleanupTimer = setInterval(() => void cleanupWorkflows().catch((error) => console.error("[workflow] cleanup failed", error)), 60 * 60 * 1_000);

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Staff1stBot] ${signal}; shutting down`);
    clearInterval(pollTimer);
    clearInterval(outboxTimer);
    clearInterval(cleanupTimer);
    server.close();
    const deadline = Date.now() + 15_000;
    while (activeJobs > 0 && Date.now() < deadline) await sleep(100);
    await Sentry.flush(2_000);
    await closeDatabase();
    process.exit(activeJobs > 0 ? 1 : 0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  console.log(`[Staff1stBot] Ready. Polling every ${config.pollIntervalMs}ms.`);
}

main().catch(async (error) => {
  console.error("[Staff1stBot] Fatal", error);
  Sentry.captureException(error);
  await Sentry.flush(2_000);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
