import "dotenv/config";
import http from "http";
import * as Ably from "ably";
import { ChatClient, ChatMessageEventType } from "@ably/chat";
import type { Room } from "@ably/chat";
import { query, queryOne, execute } from "./db.js";
import { processMessage } from "./ai.js";

const BOT_USER_ID = process.env.BOT_USER_ID!;
const BOT_NAME = "Staff1st Bot";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS ?? "30000", 10);
const PORT = parseInt(process.env.PORT ?? "3000", 10);

if (!BOT_USER_ID) {
  console.error("BOT_USER_ID is required.");
  process.exit(1);
}
if (!process.env.ABLY_API_KEY) {
  console.error("ABLY_API_KEY is required.");
  process.exit(1);
}

const activeRooms = new Map<string, Room>();
const processingQueue = new Map<string, boolean>();

async function ensureBotUser() {
  const existing = await queryOne<{ auth_user_id: string }>(
    `SELECT auth_user_id FROM shared.user_profiles WHERE auth_user_id = $1`,
    [BOT_USER_ID]
  );
  if (!existing) {
    console.log(`[Staff1stBot] Registering bot user (${BOT_USER_ID})...`);
    await execute(
      `INSERT INTO shared.user_profiles (auth_user_id, email, full_name)
       VALUES ($1, $2, $3) ON CONFLICT (auth_user_id) DO NOTHING`,
      [BOT_USER_ID, "staff1st-bot@internal.locum1st", BOT_NAME]
    );
  }

  // Ensure locum1st profile exists (needs user_profile_id FK)
  const profileExists = await queryOne<{ auth_user_id: string }>(
    `SELECT auth_user_id FROM locum1st.profiles WHERE auth_user_id = $1`,
    [BOT_USER_ID]
  );
  if (!profileExists) {
    const sharedProfile = await queryOne<{ id: number }>(
      `SELECT id FROM shared.user_profiles WHERE auth_user_id = $1`,
      [BOT_USER_ID]
    );
    if (sharedProfile) {
      await execute(
        `INSERT INTO locum1st.profiles (auth_user_id, user_profile_id, role_type, onboarding_completed_at)
         VALUES ($1, $2, 'bot', now()) ON CONFLICT (auth_user_id) DO NOTHING`,
        [BOT_USER_ID, sharedProfile.id]
      );
      console.log(`[Staff1stBot] Bot user registered.`);
    }
  }
}

async function attachToRoom(chatClient: ChatClient, conversationId: string) {
  if (activeRooms.has(conversationId)) return;

  const roomName = `convo-${conversationId}`;

  try {
    const room = await chatClient.rooms.get(roomName);
    await room.attach();

    room.messages.subscribe((event) => {
      if (event.type !== ChatMessageEventType.Created) return;
      const msg = event.message;
      if (msg.clientId === BOT_USER_ID) return;
      if (processingQueue.get(conversationId)) return;

      processingQueue.set(conversationId, true);
      console.log(`[${new Date().toISOString()}] [${roomName}] ${msg.clientId}: ${msg.text.slice(0, 100)}`);

      processMessage(conversationId, msg.text)
        .then(async (response) => {
          await room.messages.send({ text: response });
          await execute(
            `UPDATE locum1st.conversations SET last_message_at = now(), last_message_preview = $2 WHERE id = $1`,
            [conversationId, `Bot: ${response.slice(0, 100)}`]
          );
          console.log(`[${new Date().toISOString()}] [${roomName}] Bot replied.`);
        })
        .catch((err) => console.error(`[${roomName}] Error:`, err))
        .finally(() => processingQueue.delete(conversationId));
    });

    activeRooms.set(conversationId, room);
    console.log(`[${new Date().toISOString()}] Attached to ${roomName}`);
  } catch (err) {
    console.error(`Failed to attach to room convo-${conversationId}:`, err);
  }
}

async function pollConversations(chatClient: ChatClient) {
  try {
    const rows = await query<{ id: string }>(
      `SELECT id FROM locum1st.conversations WHERE participant_a = $1 OR participant_b = $1`,
      [BOT_USER_ID]
    );
    const newRooms = rows.filter((r) => !activeRooms.has(r.id));
    if (newRooms.length > 0) {
      console.log(`[${new Date().toISOString()}] Found ${newRooms.length} new conversation(s).`);
      await Promise.all(newRooms.map((r) => attachToRoom(chatClient, r.id)));
    }
  } catch (err) {
    console.error("Poll error:", err);
  }
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", rooms: activeRooms.size }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(PORT, () => console.log(`[Staff1stBot] Health server on :${PORT}`));
}

async function main() {
  await ensureBotUser();

  const realtime = new Ably.Realtime({
    key: process.env.ABLY_API_KEY!,
    clientId: BOT_USER_ID,
  });
  const chatClient = new ChatClient(realtime);

  console.log(`[Staff1stBot] Starting — clientId: ${BOT_USER_ID}`);

  startHealthServer();
  await pollConversations(chatClient);
  setInterval(() => pollConversations(chatClient), POLL_INTERVAL);

  console.log(`[Staff1stBot] Ready. Polling every ${POLL_INTERVAL / 1000}s.`);

  process.on("SIGTERM", () => { realtime.close(); process.exit(0); });
  process.on("SIGINT", () => { realtime.close(); process.exit(0); });
}

main().catch((err) => {
  console.error("[Staff1stBot] Fatal:", err);
  process.exit(1);
});
