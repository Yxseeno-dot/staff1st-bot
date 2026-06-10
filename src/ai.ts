import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const MAX_HISTORY = 20; // cap per-conversation to control token costs

const SYSTEM_PROMPT = `You are Staff1st Bot, a helpful assistant for locum pharmacists using the Locum1st platform.

You help locums with:
- Understanding and evaluating shift offers (pay rates, travel, hours)
- Logging completed shifts and mileage
- Answering questions about HMRC mileage rates (45p/mile up to 10,000 miles, 25p/mile after)
- Generating and sending invoices to pharmacies
- General questions about working as a locum pharmacist in the UK

Keep responses concise and practical. Use plain text — no markdown formatting.
If a locum sends you a shift offer, extract the key details (date, pharmacy, hours, rate) and confirm them back clearly.
If you can't help with something, say so briefly and suggest they contact support.`;

type Message = OpenAI.Chat.ChatCompletionMessageParam;

// Per-conversation history stored in memory
const histories = new Map<string, Message[]>();

export async function processMessage(conversationId: string, text: string): Promise<string> {
  const history = histories.get(conversationId) ?? [];

  history.push({ role: "user", content: text });

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    max_tokens: 500,
  });

  const reply = response.choices[0]?.message?.content ?? "Sorry, I couldn't process that. Please try again.";

  history.push({ role: "assistant", content: reply });

  // Keep last MAX_HISTORY messages to cap token costs
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  histories.set(conversationId, history);

  return reply;
}
