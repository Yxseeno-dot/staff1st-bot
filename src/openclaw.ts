import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
// In Docker (node:20-alpine, runs as root) openclaw is in PATH; on host the full path is used
const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "openclaw";
// HOME must point to where .openclaw state is mounted (Docker: /root, host: /home/ubuntu)
const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? "/root";

// Per-conversation OpenClaw session IDs kept in memory
const sessions = new Map<string, string>();

export async function processMessage(conversationId: string, text: string): Promise<string> {
  const sessionId = sessions.get(conversationId);

  const args = [
    "agent", "--agent", "locum1st-bot",
    "--local", "--message", text,
    "--json",
  ];
  if (sessionId) args.push("--session-id", sessionId);

  const { stdout } = await exec(OPENCLAW_BIN, args, {
    timeout: 90_000,
    env: { ...process.env, HOME: OPENCLAW_HOME },
  });

  const result = JSON.parse(stdout.trim()) as {
    payloads?: Array<{ text?: string }>;
    meta?: { sessionId?: string };
  };

  const response = result.payloads?.[0]?.text ?? "Sorry, I couldn't process that. Please try again.";
  const newSessionId = result.meta?.sessionId;
  if (newSessionId) sessions.set(conversationId, newSessionId);

  return response;
}
