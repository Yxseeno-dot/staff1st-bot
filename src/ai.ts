import OpenAI from "openai";

// Force Node's native fetch instead of the SDK's bundled node-fetch v2, which has a
// known intermittent ERR_STREAM_PREMATURE_CLOSE bug on gzip-compressed responses.
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch });
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const BEARER = process.env.BOT_API_BEARER;
if (!BEARER) throw new Error("BOT_API_BEARER is required");
const BASE = process.env.BOT_API_BASE ?? "https://locum1st.net/api/bot";

// ─── Types ───────────────────────────────────────────────────────────────────

// Recursive JSON-safe type, stored as JSONB on locum1st.messages.metadata
type JsonVal = string | number | boolean | null | JsonVal[] | { [k: string]: JsonVal };
export type BotMetadata = { [k: string]: JsonVal };

export type BotReply = {
  text: string;
  metadata?: BotMetadata;
};

type PendingShift = {
  pharmacy_name: string;
  pharmacy_address?: string;
  pharmacy_ods_code?: string;
  shift_date: string;
  start_time: string;
  end_time: string;
  hourly_rate: number;
  shift_type: string;
  mileage_paid: boolean;
  mileage_pence_per_mile?: number;
  mileage_threshold_miles?: number;
};

type Shift = {
  id: string;
  pharmacy_name: string;
  pharmacy_address: string | null;
  shift_date: string;
  start_time: string;
  end_time: string;
  hourly_rate: string;
};

type State =
  | { phase: "idle" }
  | { phase: "awaiting_confirmation"; pending: PendingShift }
  | { phase: "awaiting_delete"; shifts: Shift[] };

// ─── In-memory state ──────────────────────────────────────────────────────────

const STATE_TTL_MS = 10 * 60 * 1000;
type StateEntry = { state: State; lastActivity: number };
const states = new Map<string, StateEntry>();

function getState(conversationId: string): State {
  const entry = states.get(conversationId);
  if (!entry || Date.now() - entry.lastActivity > STATE_TTL_MS) {
    states.delete(conversationId);
    return { phase: "idle" };
  }
  return entry.state;
}

function setState(conversationId: string, state: State): void {
  states.set(conversationId, { state, lastActivity: Date.now() });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of states) {
    if (now - entry.lastActivity > STATE_TTL_MS) states.delete(id);
  }
}, STATE_TTL_MS).unref();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function plain(text: string): BotReply { return { text }; }
function confirmShift(text: string): BotReply { return { text, metadata: { action: "confirm_shift" } }; }
function selectDelete(text: string, shifts: Array<{ name: string; date: string }>): BotReply {
  return { text, metadata: { action: "select_delete", shifts: shifts as unknown as JsonVal } };
}

async function botFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${BEARER}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Bot API error ${res.status} for ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── Shift extraction via LLM ─────────────────────────────────────────────────

type ShiftExtraction = {
  is_shift_offer: boolean;
  pharmacy_name?: string;
  pharmacy_postcode?: string;
  pharmacy_address?: string;
  shift_date?: string;
  start_time?: string;
  end_time?: string;
  hourly_rate?: number | null;
  shift_type?: string;
  mileage_paid?: boolean;
  mileage_pence_per_mile?: number | null;
  mileage_threshold_miles?: number | null;
};

async function extractShift(text: string): Promise<ShiftExtraction> {
  const today = new Date().toISOString().slice(0, 10);
  const res = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    max_tokens: 400,
    messages: [
      {
        role: "system",
        content: `Extract shift offer details from text. Return JSON.
Today is ${today}. Convert relative dates to YYYY-MM-DD.
Fields:
- is_shift_offer: boolean
- pharmacy_name: string | null
- pharmacy_postcode: string | null
- pharmacy_address: string | null
- shift_date: "YYYY-MM-DD" | null
- start_time: "HH:MM" | null (24h)
- end_time: "HH:MM" | null (24h)
- hourly_rate: number | null
- shift_type: "standard" | "overnight" | "bank_holiday"
- mileage_paid: boolean
- mileage_pence_per_mile: number | null
- mileage_threshold_miles: number | null`,
      },
      { role: "user", content: text },
    ],
  });
  try {
    return JSON.parse(res.choices[0]?.message?.content ?? "{}") as ShiftExtraction;
  } catch {
    return { is_shift_offer: false };
  }
}

// ─── Rate & verdict logic ─────────────────────────────────────────────────────

function recommendedRate(avgItems: number, shiftType: string): number {
  let base: number;
  if (avgItems > 8000) base = 28;
  else if (avgItems > 6000) base = 26;
  else if (avgItems > 3500) base = 24;
  else base = 22;
  if (shiftType === "bank_holiday") base += 4;
  else if (shiftType === "overnight") base += 3;
  return base;
}

function verdict(rate: number, avgItems: number, shiftType: string): string {
  const rec = recommendedRate(avgItems, shiftType);
  if (rate >= rec + 1) return "Worth taking";
  if (rate >= rec - 1) return "Fair rate";
  if (rate >= rec - 3) return "Consider carefully";
  return "Below market rate";
}

function verdictReason(rate: number, avgItems: number, shiftType: string): string {
  const rec = recommendedRate(avgItems, shiftType);
  const busy = avgItems > 8000 ? "busy" : avgItems > 4000 ? "moderate" : "quieter";
  const diff = rate - rec;
  if (diff >= 1) return `${busy.charAt(0).toUpperCase() + busy.slice(1)} pharmacy paying above market for its workload.`;
  if (diff >= -1) return `Rate matches the expected range for a ${busy} pharmacy like this.`;
  if (diff >= -3) return `Rate is a little low for a ${busy} pharmacy (market ~£${rec}/hr). Negotiate if you can.`;
  return `Rate is well below market for this workload. Market rate here is ~£${rec}/hr.`;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function fmtDate(d: string): string {
  // Normalise to YYYY-MM-DD — pg may return full ISO strings for DATE columns
  const dateOnly = d.slice(0, 10);
  return new Date(dateOnly + "T12:00:00Z").toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

function fmtDateShort(d: string): string {
  const dateOnly = d.slice(0, 10);
  return new Date(dateOnly + "T12:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function hoursDecimal(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = eh * 60 + em - (sh * 60 + sm);
  return (mins < 0 ? mins + 24 * 60 : mins) / 60;
}

// ─── Sub-handlers ─────────────────────────────────────────────────────────────

async function handleShiftAnalysis(
  conversationId: string,
  userId: string,
  ext: ShiftExtraction
): Promise<BotReply> {
  // Build the best possible search query from whatever pharmacy info is available
  const searchQuery = [
    ext.pharmacy_name,
    ext.pharmacy_postcode,
    ext.pharmacy_address,
  ].filter(Boolean).join(" ").trim();

  let match: { odsCode: string; name: string; address: string } | undefined;
  if (searchQuery) {
    const pharmacyData = await botFetch<{ results?: Array<{ odsCode: string; name: string; address: string }> }>(
      `/pharmacy?q=${encodeURIComponent(searchQuery)}`
    );
    match = pharmacyData.results?.[0];
  }

  type HistoryMonth = { items: number; pharmacyFirstTotal: number; nms: number; bpChecks: number };
  type HistoryData = { months?: HistoryMonth[] };
  let history: HistoryData = {};
  if (match?.odsCode) {
    history = await botFetch<HistoryData>(`/pharmacy/history?ods=${match.odsCode}`);
  }

  const months = (history.months ?? []).slice(0, 6);
  const avg = (key: keyof HistoryMonth) =>
    months.length ? Math.round(months.reduce((s, m) => s + (m[key] ?? 0), 0) / months.length) : null;

  const avgItems = avg("items");
  const avgPF = avg("pharmacyFirstTotal");
  const avgNms = avg("nms");
  const avgBp = avg("bpChecks");

  type DistData = { oneway_miles?: number; return_miles?: number; duration_text?: string; error?: string };
  const toAddr = match?.address ?? ext.pharmacy_address ?? ext.pharmacy_postcode ?? ext.pharmacy_name ?? "";
  let dist: DistData = {};
  if (toAddr) {
    try {
      dist = await botFetch<DistData>(
        `/distance?auth_user_id=${encodeURIComponent(userId)}&to=${encodeURIComponent(toAddr)}`
      );
      console.log(`[${conversationId}] Distance result for "${toAddr}":`, JSON.stringify(dist));
    } catch (err) {
      console.error(`[${conversationId}] Distance lookup failed:`, err);
      dist = { error: "lookup_failed" };
    }
  } else {
    dist = { error: "no_address" };
  }

  const hours = hoursDecimal(ext.start_time!, ext.end_time!);
  const shiftType = ext.shift_type ?? "standard";
  const rateProvided = ext.hourly_rate != null;
  const rate = ext.hourly_rate ?? recommendedRate(avgItems ?? 3000, shiftType);
  const totalPay = (rate * hours).toFixed(0);

  const pending: PendingShift = {
    pharmacy_name: match?.name ?? ext.pharmacy_name ?? "Unknown",
    pharmacy_address: match?.address ?? ext.pharmacy_address ?? ext.pharmacy_postcode,
    pharmacy_ods_code: match?.odsCode,
    shift_date: ext.shift_date!,
    start_time: ext.start_time!,
    end_time: ext.end_time!,
    hourly_rate: rate,
    shift_type: shiftType,
    mileage_paid: ext.mileage_paid ?? false,
    mileage_pence_per_mile: ext.mileage_pence_per_mile ?? undefined,
    mileage_threshold_miles: ext.mileage_threshold_miles ?? undefined,
  };
  setState(conversationId, { phase: "awaiting_confirmation", pending });

  const lines: string[] = [];
  lines.push("**SHIFT SUMMARY**");
  lines.push("");
  lines.push(`**Pharmacy:** ${match?.name ?? ext.pharmacy_name ?? "Unknown"} (${match?.odsCode ?? "ODS not found"})`);
  if (match?.address) lines.push(`**Address:** ${match.address}`);
  lines.push(`**Date:** ${fmtDate(ext.shift_date!)} | ${ext.start_time}–${ext.end_time} (${hours % 1 === 0 ? hours : hours.toFixed(1)} hrs)`);

  if (!rateProvided) {
    lines.push(`**Rate:** No rate offered — suggested: £${rate}/hr = £${totalPay} for the day`);
  } else {
    lines.push(`**Rate:** £${rate}/hr = £${totalPay} for the day`);
  }

  if (!dist.error && dist.oneway_miles != null) {
    lines.push(`**Distance:** ${dist.oneway_miles} mi one-way (${dist.return_miles} mi return) — ${dist.duration_text ?? "?"} drive`);
  } else if (dist.error === "no_postcode") {
    lines.push("**Distance:** Add your home postcode in account settings.");
  } else if (dist.error === "no_address") {
    lines.push("**Distance:** No pharmacy address found — can't calculate route.");
  } else if (dist.error === "no_route") {
    lines.push(`**Distance:** Google couldn't find a route to "${toAddr}".`);
  } else if (dist.error === "no_maps_key" || dist.error === "maps_api_error" || dist.error === "lookup_failed") {
    lines.push("**Distance:** Unavailable (maps service error).");
  }

  lines.push("");

  if (avgItems != null) {
    lines.push("**WORKLOAD** (avg last 6 months)");
    lines.push(`Items: ~${avgItems.toLocaleString()}/month`);
    lines.push(`Pharmacy First: ~${(avgPF ?? 0).toLocaleString()}/month`);
    lines.push(`NMS: ~${(avgNms ?? 0).toLocaleString()}/month`);
    lines.push(`BP Checks: ~${(avgBp ?? 0).toLocaleString()}/month`);
  } else {
    lines.push("**WORKLOAD:** No Data1st data available for this pharmacy.");
  }

  lines.push("");

  if (rateProvided && avgItems != null) {
    lines.push(`**VERDICT:** ${verdict(rate, avgItems, shiftType)}`);
    lines.push(verdictReason(rate, avgItems, shiftType));
  } else if (!rateProvided && avgItems != null) {
    lines.push(`**RATE SUGGESTION:** £${recommendedRate(avgItems, shiftType)}/hr`);
    lines.push(`Based on ${avgItems.toLocaleString()} items/month avg. Counter at or above this rate.`);
  } else if (rateProvided) {
    lines.push(`**VERDICT:** ${verdict(rate, 3000, shiftType)} (no workload data — rate only)`);
    lines.push(`Market rate for a standard pharmacy is around £${recommendedRate(3000, shiftType)}/hr.`);
  }

  lines.push("");

  if (ext.mileage_paid && ext.mileage_pence_per_mile) {
    const ppm = ext.mileage_pence_per_mile;
    const threshold = ext.mileage_threshold_miles ?? 0;
    if (threshold > 0) {
      lines.push(`**Mileage:** ${ppm}p/mile after the first ${threshold} miles each way (pharmacy pays)`);
      lines.push(`The first ${threshold} miles each way are at your own cost — HMRC Mileage Tax Relief at 55p/mile applies to all miles.`);
      if (!dist.error && dist.oneway_miles != null) {
        const reimbursedOneWay = Math.max(0, dist.oneway_miles - threshold);
        if (reimbursedOneWay > 0) {
          const reimbursedReturn = reimbursedOneWay * 2;
          const amount = (reimbursedReturn * ppm / 100).toFixed(2);
          lines.push(`On this shift: ${reimbursedReturn.toFixed(1)} mi reimbursed by pharmacy (£${amount}), ${threshold} mi each way at your own cost.`);
        } else {
          lines.push(`On this shift: journey (${dist.oneway_miles} mi) is within the ${threshold} mi threshold — no reimbursement from pharmacy on this shift.`);
        }
      }
    } else {
      lines.push(`**Mileage:** ${ppm}p/mile (pharmacy pays all miles)`);
      lines.push("HMRC Mileage Tax Relief at 55p/mile also applies.");
    }
  } else {
    lines.push("**Mileage:** HMRC Mileage Tax Relief at 55p/mile (no reimbursement mentioned)");
  }

  return confirmShift(lines.join("\n"));
}

async function handleSaveShift(conversationId: string, userId: string, pending: PendingShift): Promise<BotReply> {
  const result = await botFetch<{
    ok?: boolean;
    mileage_miles?: number | null;
    mileage_manual_needed?: boolean;
    error?: string;
  }>("/save-shift", {
    method: "POST",
    body: JSON.stringify({ auth_user_id: userId, pending_shift: pending }),
  });

  setState(conversationId, { phase: "idle" });

  if (result.error === "no_pending_shift") return plain("Session expired. Please send the shift message again.");
  if (!result.ok) return plain("Failed to log the shift. Please try again or add it manually at locum1st.net/shifts");

  const lines = [
    "**Shift logged!**",
    "",
    `**Pharmacy:** ${pending.pharmacy_name}`,
    `**Date:** ${fmtDate(pending.shift_date)}, ${pending.start_time}–${pending.end_time}`,
    `**Rate:** £${pending.hourly_rate}/hr`,
  ];
  if (result.mileage_miles) lines.push("", `**Mileage:** ${result.mileage_miles} mi auto-logged (HMRC Mileage Tax Relief at 55p/mi).`);
  else if (result.mileage_manual_needed) lines.push("", "Add mileage manually at locum1st.net/mileage");
  lines.push("", "View at locum1st.net/shifts");
  return plain(lines.join("\n"));
}

async function handleListShiftsForDelete(conversationId: string, userId: string): Promise<BotReply> {
  const data = await botFetch<{ shifts?: Shift[] }>(
    `/shifts?auth_user_id=${encodeURIComponent(userId)}&upcoming=true`
  );

  if (!data.shifts?.length) return plain("You have no upcoming shifts logged.");

  setState(conversationId, { phase: "awaiting_delete", shifts: data.shifts });

  const list = data.shifts
    .map((s, i) => `${i + 1}. **${s.pharmacy_name}** — ${fmtDateShort(s.shift_date)}, ${s.start_time}–${s.end_time}`)
    .join("\n");

  const shiftMeta = data.shifts.map((s) => ({ name: s.pharmacy_name, date: fmtDateShort(s.shift_date) }));
  return selectDelete(`**Which shift do you want to cancel?**\n\n${list}`, shiftMeta);
}

async function handleDeleteShift(conversationId: string, userId: string, shift: Shift): Promise<BotReply> {
  const result = await botFetch<{ ok?: boolean }>("/delete-shift", {
    method: "POST",
    body: JSON.stringify({ auth_user_id: userId, shift_id: shift.id }),
  });

  setState(conversationId, { phase: "idle" });

  if (!result.ok) return plain("Failed to delete that shift. Try again or remove it manually at locum1st.net/shifts");

  return plain([
    "**Shift deleted.**",
    "",
    `**Pharmacy:** ${shift.pharmacy_name}`,
    `**Date:** ${fmtDate(shift.shift_date)}, ${shift.start_time}–${shift.end_time}`,
    "",
    "The linked mileage log has also been removed.",
  ].join("\n"));
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function processMessage(
  conversationId: string,
  userId: string,
  text: string
): Promise<BotReply> {
  const state = getState(conversationId);
  const trimmed = text.trim();

  // ── Awaiting YES/NO ──────────────────────────────────────────────────────
  if (state.phase === "awaiting_confirmation") {
    if (/^(yes|y|confirm|log|accept|ok|sure|yep|yeah)\b/i.test(trimmed)) {
      return handleSaveShift(conversationId, userId, state.pending);
    }
    if (/^(no|n|decline|skip|nope|cancel|pass)\b/i.test(trimmed)) {
      setState(conversationId, { phase: "idle" });
      return plain("Shift declined. Send another shift offer whenever you're ready.");
    }
    setState(conversationId, { phase: "idle" });
  }

  // ── Awaiting delete selection ────────────────────────────────────────────
  if (state.phase === "awaiting_delete") {
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= state.shifts.length) {
      return handleDeleteShift(conversationId, userId, state.shifts[num - 1]);
    }
    if (/^\d+$/.test(trimmed)) {
      return plain(`That number isn't in the list. Reply with a number from 1 to ${state.shifts.length}.`);
    }
    setState(conversationId, { phase: "idle" });
  }

  // ── Pro check ───────────────────────────────────────────────────────────
  const userStatus = await botFetch<{ linked?: boolean; pro?: boolean }>(
    `/user?auth_user_id=${encodeURIComponent(userId)}`
  );
  if (!userStatus?.linked || !userStatus?.pro) {
    return plain("Shift analysis is a Locum1st Pro feature. Upgrade to Pro at locum1st.net/upgrade to use the bot.");
  }

  // ── Cancel / delete shift ────────────────────────────────────────────────
  if (
    /\b(cancel|cancelled|cancelling|delete|deleted|remove|removed)\b/i.test(trimmed) &&
    /\bshift\b/i.test(trimmed)
  ) {
    return handleListShiftsForDelete(conversationId, userId);
  }

  // ── Show shifts ─────────────────────────────────────────────────────────
  if (/\b(show|list|my)\b.*\bshift(s)?\b/i.test(trimmed)) {
    const data = await botFetch<{ shifts?: Shift[] }>(`/shifts?auth_user_id=${encodeURIComponent(userId)}`);
    if (!data.shifts?.length) return plain("You have no recent shifts logged.");
    return plain(data.shifts
      .map((s, i) => `${i + 1}. **${s.pharmacy_name}** — ${fmtDate(s.shift_date)}, ${s.start_time}–${s.end_time}, £${s.hourly_rate}/hr`)
      .join("\n"));
  }

  // ── Greeting ────────────────────────────────────────────────────────────
  if (/^(hi|hello|hey|help|what can you|what do you)\b/i.test(trimmed.toLowerCase()) && trimmed.length < 40) {
    return plain("Send me a shift offer and I'll analyse it:\n\n**Rate** vs workload\n**Driving distance** from your home\n**Verdict** on whether the pay is fair\n\nThen log it to your shifts if you want to accept it.");
  }

  // ── Extract shift offer ─────────────────────────────────────────────────
  const ext = await extractShift(text);

  if (!ext.is_shift_offer) {
    return plain("I'm here to analyse shifts and log them. Forward a shift offer to get started.");
  }

  const missing: string[] = [];
  if (!ext.shift_date) missing.push("Date");
  if (!ext.start_time) missing.push("Start time");
  if (!ext.end_time) missing.push("End time");
  if (missing.length) {
    return plain(`I need a bit more detail. Please include:\n${missing.map(m => `- ${m}`).join("\n")}`);
  }

  console.log(`[${conversationId}] Analysing: ${ext.pharmacy_name} ${ext.shift_date} ${ext.start_time}-${ext.end_time}`);
  return handleShiftAnalysis(conversationId, userId, ext);
}
