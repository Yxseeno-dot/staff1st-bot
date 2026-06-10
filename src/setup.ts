import "dotenv/config";
import { randomUUID } from "crypto";
import { queryOne, execute } from "./db.js";

const BOT_NAME = "Staff1st Bot";
const BOT_ROLE_TYPE = "bot";

async function setup() {
  const existingId = process.env.BOT_USER_ID;

  // Check if already registered
  const existing = await queryOne<{ auth_user_id: string }>(
    `SELECT auth_user_id FROM shared.user_profiles WHERE full_name = $1`,
    [BOT_NAME]
  );

  if (existing) {
    console.log(`Bot user already exists.`);
    console.log(`BOT_USER_ID=${existing.auth_user_id}`);
    process.exit(0);
  }

  const id = existingId ?? randomUUID();

  await execute(
    `INSERT INTO shared.user_profiles (auth_user_id, full_name) VALUES ($1, $2) ON CONFLICT (auth_user_id) DO NOTHING`,
    [id, BOT_NAME]
  );

  await execute(
    `INSERT INTO locum1st.profiles (auth_user_id, role_type, onboarding_completed_at)
     VALUES ($1, $2, now()) ON CONFLICT (auth_user_id) DO NOTHING`,
    [id, BOT_ROLE_TYPE]
  );

  console.log(`Bot user created successfully.`);
  console.log(`Add to your .env file:\nBOT_USER_ID=${id}`);
  process.exit(0);
}

setup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
