import "dotenv/config";
import * as Sentry from "@sentry/node";
import http from "http";
import { query, execute } from "./db.js";
import { processMessage, type BotReply } from "./ai.js";

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
}

const BOT_USER_ID = process.env.BOT_USER_ID!;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS ?? "30000", 10);
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const CENTRIFUGO_URL = process.env.CENTRIFUGO_URL!;
const CENTRIFUGO_API_KEY = process.env.CENTRIFUGO_API_KEY!;

if (!BOT_USER_ID) {
  console.error("BOT_USER_ID is required.");
  process.exit(1);
}
if (!CENTRIFUGO_URL || !CENTRIFUGO_API_KEY) {
  console.error("CENTRIFUGO_URL and CENTRIFUGO_API_KEY are required.");
  process.exit(1);
}

type UnprocessedMessage = {
  id: string;
  conversation_id: string;
  text: string;
  user_id: string;
};

const inFlight = new Set<string>();
const inFlightConvos = new Set<string>();
const MIN_TYPING_MS = 900;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Rejects with `label` after `ms` if `promise` hasn't settled — a safety net
// so a hang anywhere inside processMessage() (a stalled DB query, a stuck
// upstream call we didn't anticipate) can't keep the typing-ping interval in
// handleMessage() alive forever. This doesn't cancel the original promise —
// Node can't cancel arbitrary work — it just stops waiting on it so the bot
// can send a fallback reply and move on to the next message.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

const PUBLISH_TIMEOUT_MS = 10_000;

async function publish(channel: string, data: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
  try {
    const res = await fetch(`${CENTRIFUGO_URL}/api/publish`, {
      method: "POST",
      headers: { "X-API-Key": CENTRIFUGO_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ channel, data }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Centrifugo publish failed: ${res.status} ${await res.text()}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// The bot's actual reply is only ever pushed live once — unlike the typing
// ping (best-effort, repeated every 3s, failures silently dropped), a single
// failed publish here means the reply sits in the DB but is never delivered
// live; the message is already marked processed by the time this runs, so
// nothing retries it later. Retry a few times before giving up so a
// transient Centrifugo/network blip doesn't silently strand a reply.
async function publishWithRetry(channel: string, data: unknown, attempts = 3): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await publish(channel, data);
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.error(`[publish] Attempt ${i}/${attempts} failed, retrying:`, err);
      await sleep(500 * i);
    }
  }
}

async function handleMessage(msg: UnprocessedMessage) {
  console.log(`[${new Date().toISOString()}] [convo-${msg.conversation_id}] ${msg.user_id}: ${msg.text.slice(0, 100)}`);

  const channel = `conversation:${msg.conversation_id}`;
  const sendTyping = () => publish(channel, { type: "typing", senderId: BOT_USER_ID }).catch(() => {});
  const startedAt = Date.now();
  sendTyping();
  // Keep the typing indicator alive for as long as the AI call takes — the
  // client clears it after a few seconds of silence, so re-ping periodically.
  const typingHeartbeat = setInterval(sendTyping, 3000);

  let reply: BotReply;
  try {
    reply = await withTimeout(
      processMessage(msg.conversation_id, msg.user_id, msg.text, msg.id),
      45_000,
      "processMessage"
    );
  } catch (err) {
    console.error(`[convo-${msg.conversation_id}] Error:`, err);
    Sentry.captureException(err);
    reply = { text: "Sorry, I hit an error processing that. Please try again." };
  } finally {
    clearInterval(typingHeartbeat);
  }

  // The bot often replies in well under a second — too fast for the typing
  // indicator to ever paint a frame before the real message replaces it.
  // Pad out to a minimum "thinking" duration so the animation is actually
  // visible instead of flashing on and off within the same render tick.
  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_TYPING_MS) {
    await sleep(MIN_TYPING_MS - elapsed);
  }

  await execute(
    `INSERT INTO locum1st.messages (conversation_id, sender_id, text, metadata)
     VALUES ($1, $2, $3, $4)`,
    [msg.conversation_id, BOT_USER_ID, reply.text, reply.metadata ?? null]
  );

  await execute(
    `UPDATE locum1st.conversations SET last_message_at = now(), last_message_preview = $2 WHERE id = $1`,
    [msg.conversation_id, `Bot: ${reply.text.slice(0, 100)}`]
  );

  // Mark processed before publishing so a Centrifugo failure doesn't cause a
  // duplicate reply on the next poll. The client re-fetches messages on reconnect.
  await execute(`UPDATE locum1st.messages SET bot_processed = true WHERE id = $1`, [msg.id]);

  await publishWithRetry(channel, {
    conversation_id: msg.conversation_id,
    sender_id: BOT_USER_ID,
    text: reply.text,
    metadata: reply.metadata ?? null,
    created_at: new Date().toISOString(),
  });
  console.log(`[${new Date().toISOString()}] [convo-${msg.conversation_id}] Bot replied.`);
}

async function pollMessages() {
  try {
    const rows = await query<UnprocessedMessage>(
      `SELECT m.id, m.conversation_id, m.text,
              CASE WHEN c.participant_a = $1 THEN c.participant_b ELSE c.participant_a END AS user_id
       FROM locum1st.messages m
       JOIN locum1st.conversations c ON c.id = m.conversation_id
       WHERE m.bot_processed = false
         AND m.sender_id <> $1
         AND (c.participant_a = $1 OR c.participant_b = $1)
       ORDER BY m.created_at ASC`,
      [BOT_USER_ID]
    );

    for (const row of rows) {
      if (inFlight.has(row.id)) continue;
      if (inFlightConvos.has(row.conversation_id)) continue;
      inFlight.add(row.id);
      inFlightConvos.add(row.conversation_id);
      handleMessage(row)
        .catch((err) => {
          console.error(`[convo-${row.conversation_id}] Failed to handle message:`, err);
          Sentry.captureException(err);
        })
        .finally(() => {
          inFlight.delete(row.id);
          inFlightConvos.delete(row.conversation_id);
        });
    }
  } catch (err) {
    console.error("Poll error:", err);
    Sentry.captureException(err);
  }
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", inFlight: inFlight.size }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(PORT, () => console.log(`[Staff1stBot] Health server on :${PORT}`));
}

async function main() {
  console.log(`[Staff1stBot] Starting — userId: ${BOT_USER_ID}`);
  startHealthServer();
  await pollMessages();
  setInterval(() => pollMessages(), POLL_INTERVAL);
  console.log(`[Staff1stBot] Ready. Polling every ${POLL_INTERVAL / 1000}s.`);
}

main().catch(async (err) => {
  console.error("[Staff1stBot] Fatal:", err);
  Sentry.captureException(err);
  await Sentry.flush(2000);
  process.exit(1);
});
