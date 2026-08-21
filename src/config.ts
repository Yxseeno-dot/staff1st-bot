function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export const config = Object.freeze({
  databaseUrl: required("DATABASE_URL"),
  botUserId: required("BOT_USER_ID"),
  botApiBase: process.env.BOT_API_BASE?.trim() || "https://locum1st.net/api/bot",
  botApiBearer: required("BOT_API_BEARER"),
  openAiApiKey: required("OPENAI_API_KEY"),
  openAiModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.6-luna",
  openAiFallbackModel: process.env.OPENAI_FALLBACK_MODEL?.trim() || "gpt-4o-mini",
  centrifugoUrl: required("CENTRIFUGO_URL").replace(/\/$/, ""),
  centrifugoApiKey: required("CENTRIFUGO_API_KEY"),
  pollIntervalMs: positiveInteger("POLL_INTERVAL_MS", 5_000),
  port: positiveInteger("PORT", 3_000),
  workerConcurrency: positiveInteger("WORKER_CONCURRENCY", 4),
  workerId: process.env.WORKER_ID?.trim() || `staff1stbot-${process.pid}`,
  sentryDsn: process.env.SENTRY_DSN?.trim(),
});
