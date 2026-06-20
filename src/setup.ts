import "dotenv/config";
import { queryOne } from "./db.js";

// 'bot-1stai' is the single canonical 1stAi account, seeded by Locum1st's own
// instrumentation.ts. This bot must use that exact account — minting a separate
// one here causes two role_type='bot' profiles, which makes Locum1st's "find
// the bot to chat with" lookup ambiguous and can leave Staff1stBot listening on
// a conversation no user is actually pointed at.
const CANONICAL_BOT_ID = "bot-1stai";

async function setup() {
  const existing = await queryOne<{ auth_user_id: string }>(
    `SELECT auth_user_id FROM locum1st.profiles WHERE auth_user_id = $1`,
    [CANONICAL_BOT_ID]
  );

  if (!existing) {
    console.error(
      `Canonical bot account '${CANONICAL_BOT_ID}' not found. It should be seeded by ` +
      `Locum1st's instrumentation.ts — make sure Locum1st has started at least once first.`
    );
    process.exit(1);
  }

  console.log(`Add to your .env file:\nBOT_USER_ID=${CANONICAL_BOT_ID}`);
  process.exit(0);
}

setup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
