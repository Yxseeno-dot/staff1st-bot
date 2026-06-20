import "dotenv/config";
import http from "http";
import { query, execute } from "./db.js";
import { processMessage, type BotReply } from "./ai.js";

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

async function publish(channel: string, data: unknown): Promise<void> {
  const res = await fetch(`${CENTRIFUGO_URL}/api/publish`, {
    method: "POST",
    headers: { "X-API-Key": CENTRIFUGO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, data }),
  });
  if (!res.ok) {
    throw new Error(`Centrifugo publish failed: ${res.status} ${await res.text()}`);
  }
}

async function handleMessage(msg: UnprocessedMessage) {
  console.log(`[${new Date().toISOString()}] [convo-${msg.conversation_id}] ${msg.user_id}: ${msg.text.slice(0, 100)}`);

  const channel = `conversation:${msg.conversation_id}`;
  const sendTyping = () => publish(channel, { type: "typing", senderId: BOT_USER_ID }).catch(() => {});
  sendTyping();
  // Keep the typing indicator alive for as long as the AI call takes — the
  // client clears it after a few seconds of silence, so re-ping periodically.
  const typingHeartbeat = setInterval(sendTyping, 3000);

  let reply: BotReply;
  try {
    reply = await processMessage(msg.conversation_id, msg.user_id, msg.text);
  } catch (err) {
    console.error(`[convo-${msg.conversation_id}] Error:`, err);
    reply = { text: "Sorry, I hit an error processing that. Please try again." };
  } finally {
    clearInterval(typingHeartbeat);
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

  await publish(channel, {
    conversation_id: msg.conversation_id,
    sender_id: BOT_USER_ID,
    text: reply.text,
    metadata: reply.metadata ?? null,
    created_at: new Date().toISOString(),
  });

  await execute(`UPDATE locum1st.messages SET bot_processed = true WHERE id = $1`, [msg.id]);
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
      inFlight.add(row.id);
      handleMessage(row)
        .catch((err) => console.error(`[convo-${row.conversation_id}] Failed to handle message:`, err))
        .finally(() => inFlight.delete(row.id));
    }
  } catch (err) {
    console.error("Poll error:", err);
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

main().catch((err) => {
  console.error("[Staff1stBot] Fatal:", err);
  process.exit(1);
});
