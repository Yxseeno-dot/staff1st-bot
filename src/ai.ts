import OpenAI from "openai";

// Force Node's native fetch instead of the SDK's bundled node-fetch v2, which has a
// known intermittent ERR_STREAM_PREMATURE_CLOSE bug on gzip-compressed responses.
// Explicit timeout: the SDK's own default is 10 minutes, which is effectively
// unbounded from a chat UX perspective — a stalled OpenAI response would hang
// processMessage() forever, leaving the bot's "typing" heartbeat running
// indefinitely (see botFetch below for the matching issue on our own API calls).
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch, timeout: 20_000 });
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

// Everything about an offered shift except which date(s) it applies to — a
// single offer can cover several dates (a rota, "Mon/Wed/Fri", etc.) sharing
// one of these templates.
type ShiftTemplate = {
  pharmacy_name: string;
  pharmacy_address?: string;
  pharmacy_ods_code?: string;
  start_time: string;
  end_time: string;
  hourly_rate: number;
  shift_type: string;
  break_duration_minutes?: number;
  break_paid?: boolean;
  mileage_paid: boolean;
  mileage_pence_per_mile?: number;
  mileage_threshold_miles?: number;
  mileage_cap_miles?: number;
  travel_allowance_fixed?: number;
};

type PendingShift = ShiftTemplate & { shift_date: string };

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
  | { phase: "awaiting_delete"; shifts: Shift[] }
  | { phase: "awaiting_date_selection"; template: ShiftTemplate; dates: string[] };

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
function selectDates(text: string, dates: string[]): BotReply {
  return { text, metadata: { action: "select_dates", dates: dates as unknown as JsonVal } };
}

const BOT_FETCH_TIMEOUT_MS = 15_000;

// Without a timeout, a stalled upstream response (Locum1st's API, or Google
// Maps inside its /distance route) leaves processMessage() awaiting forever —
// which means handleMessage()'s typing-ping interval (index.ts) never reaches
// its `finally` and clears, so the client's typing indicator gets refreshed
// every 3s indefinitely instead of self-clearing after a few seconds.
async function botFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${BEARER}`,
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bot API error ${res.status} for ${path}: ${body}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Bot API timed out after ${BOT_FETCH_TIMEOUT_MS}ms for ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Shift extraction via LLM ─────────────────────────────────────────────────

type ShiftExtraction = {
  is_shift_offer: boolean;
  pharmacy_name?: string;
  pharmacy_postcode?: string;
  pharmacy_address?: string;
  shift_dates?: string[];
  start_time?: string;
  end_time?: string;
  hourly_rate?: number | null;
  shift_type?: string;
  break_duration_minutes?: number | null;
  break_paid?: boolean;
  mileage_paid?: boolean;
  mileage_pence_per_mile?: number | null;
  mileage_threshold_miles?: number | null;
  mileage_cap_miles?: number | null;
  travel_allowance_fixed?: number | null;
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
Today is ${today}. Convert relative or informal dates to YYYY-MM-DD using today as the reference — "tomorrow", "next Tue", "this Sat", and bare day names like "Wednesday" should all resolve to a specific date, not be left null just because they're not already in YYYY-MM-DD form.
Parse informal or 12-hour times too — "9am", "9:00am", "09:00", "nine o'clock", "9-5" (meaning 09:00-17:00) should all convert to 24h HH:MM.
If only a duration is given alongside a start time (e.g. "8 hour shift from 9am"), compute end_time yourself from start_time + duration.
If end_time would be earlier than start_time, that's an overnight shift spanning into the next day — extract the times as given rather than treating them as invalid.
If the SAME shift pattern (same pharmacy, times, and rate) is offered across multiple dates — a rota, a list of days ("Mon/Wed/Fri"), or a phrase like "every day next week" — include every date in shift_dates, not just the first one you see.
Fields:
- is_shift_offer: boolean
- pharmacy_name: string | null
- pharmacy_postcode: string | null
- pharmacy_address: string | null
- shift_dates: array of "YYYY-MM-DD" strings — every date this shift pattern applies to (usually just one, but see above)
- start_time: "HH:MM" | null (24h)
- end_time: "HH:MM" | null (24h)
- hourly_rate: number | null
- shift_type: "standard" | "overnight" | "bank_holiday"
- break_duration_minutes: number | null (length of any lunch/rest break mentioned, in minutes)
- break_paid: boolean (true only if the text says the break IS paid; default false — most breaks are unpaid unless stated otherwise)
- mileage_paid: boolean (true ONLY for a per-mile rate, e.g. "45p a mile" — false if travel is a flat/fixed amount)
- mileage_pence_per_mile: number | null (only set when there's a per-mile rate)
- mileage_threshold_miles: number | null (miles each way the locum covers themselves before per-mile reimbursement starts)
- mileage_cap_miles: number | null (miles each way beyond which the pharmacy stops reimbursing per-mile travel, e.g. "up to 30 miles") — only relevant with a per-mile rate
- travel_allowance_fixed: number | null (a flat £ travel allowance for the whole shift, e.g. "plus £20 travel" — mutually exclusive with a per-mile rate; leave mileage_paid false and mileage_pence_per_mile null when this is set)`,
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

function fmtDateWeekdayShort(d: string): string {
  const dateOnly = d.slice(0, 10);
  return new Date(dateOnly + "T12:00:00Z").toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
  });
}

// Parses a typed reply to a date-selection prompt: "all", a single number,
// comma/space-separated numbers ("1,3" / "1 3" / "1 and 3"), simple ranges
// ("1-3"), and ordinal suffixes ("1st, 3rd"). Returns sorted, de-duplicated
// 1-based indices, or null if nothing valid was found.
function parseDateSelection(input: string, max: number): number[] | null {
  const tokens = input
    .replace(/\band\b/gi, ",")
    .split(/[,\s]+/)
    .map((t) => t.trim().replace(/(st|nd|rd|th)$/i, ""))
    .filter(Boolean);
  if (!tokens.length) return null;

  const indices = new Set<number>();
  for (const token of tokens) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      if (start < 1 || end > max || start > end) return null;
      for (let i = start; i <= end; i++) indices.add(i);
      continue;
    }
    if (!/^\d+$/.test(token)) return null;
    const num = parseInt(token, 10);
    if (num < 1 || num > max) return null;
    indices.add(num);
  }
  return indices.size ? Array.from(indices).sort((a, b) => a - b) : null;
}

function hoursDecimal(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = eh * 60 + em - (sh * 60 + sm);
  return (mins < 0 ? mins + 24 * 60 : mins) / 60;
}

// Matches the web app's calcHours() (src/components/shifts/helpers.ts) — an
// unpaid break is deducted from paid hours, a paid break is not.
function paidHours(rawHours: number, breakMinutes: number, breakPaid: boolean): number {
  return breakPaid ? rawHours : rawHours - breakMinutes / 60;
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

  const rawHours = hoursDecimal(ext.start_time!, ext.end_time!);
  const breakMinutes = ext.break_duration_minutes ?? 0;
  const breakPaid = ext.break_paid ?? false;
  const hours = paidHours(rawHours, breakMinutes, breakPaid);
  const shiftType = ext.shift_type ?? "standard";
  const rateProvided = ext.hourly_rate != null;
  const rate = ext.hourly_rate ?? recommendedRate(avgItems ?? 3000, shiftType);
  const totalPay = (rate * hours).toFixed(0);

  const template: ShiftTemplate = {
    pharmacy_name: match?.name ?? ext.pharmacy_name ?? "Unknown",
    pharmacy_address: match?.address ?? ext.pharmacy_address ?? ext.pharmacy_postcode,
    pharmacy_ods_code: match?.odsCode,
    start_time: ext.start_time!,
    end_time: ext.end_time!,
    hourly_rate: rate,
    shift_type: shiftType,
    break_duration_minutes: breakMinutes || undefined,
    break_paid: breakPaid,
    mileage_paid: ext.mileage_paid ?? false,
    mileage_pence_per_mile: ext.mileage_pence_per_mile ?? undefined,
    mileage_threshold_miles: ext.mileage_threshold_miles ?? undefined,
    mileage_cap_miles: ext.mileage_cap_miles ?? undefined,
    travel_allowance_fixed: ext.travel_allowance_fixed ?? undefined,
  };
  const dates = ext.shift_dates!;

  const lines: string[] = [];
  lines.push("**SHIFT SUMMARY**");
  lines.push("");
  lines.push(`**Pharmacy:** ${match?.name ?? ext.pharmacy_name ?? "Unknown"} (${match?.odsCode ?? "ODS not found"})`);
  if (match?.address) lines.push(`**Address:** ${match.address}`);
  const hoursLabel = hours % 1 === 0 ? hours : hours.toFixed(1);
  const breakNote = breakMinutes > 0 ? ` — ${breakMinutes} min ${breakPaid ? "paid" : "unpaid"} break` : "";
  if (dates.length === 1) {
    lines.push(`**Date:** ${fmtDate(dates[0])} | ${ext.start_time}–${ext.end_time} (${hoursLabel} hrs paid${breakNote})`);
  } else {
    lines.push(`**Time:** ${ext.start_time}–${ext.end_time} (${hoursLabel} hrs paid${breakNote}) — offered on ${dates.length} dates, see below`);
  }

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
    // Mirrors computeMileageReimbursement() (src/lib/mileageCalc.ts) — cap is
    // applied to one-way miles before the threshold is subtracted.
    const ppm = ext.mileage_pence_per_mile;
    const threshold = ext.mileage_threshold_miles ?? 0;
    const cap = ext.mileage_cap_miles ?? null;
    let rateDesc = `${ppm}p/mile`;
    if (threshold > 0) rateDesc += ` after the first ${threshold} miles each way`;
    if (cap) rateDesc += `, up to ${cap} miles each way`;
    lines.push(`**Mileage:** ${rateDesc} (pharmacy pays)`);
    if (threshold > 0) {
      lines.push(`The first ${threshold} miles each way are at your own cost.`);
    }
    if (!dist.error && dist.oneway_miles != null) {
      const cappedOneWay = cap ? Math.min(dist.oneway_miles, cap) : dist.oneway_miles;
      const reimbursedOneWay = Math.max(0, cappedOneWay - threshold);
      if (reimbursedOneWay > 0) {
        const reimbursedReturn = reimbursedOneWay * 2;
        const amount = (reimbursedReturn * ppm / 100).toFixed(2);
        const capNote = cap && dist.oneway_miles > cap ? ` (capped at ${cap} mi each way)` : "";
        lines.push(`On this shift: ${reimbursedReturn.toFixed(1)} mi reimbursed by pharmacy (£${amount})${capNote}.`);
      } else {
        lines.push(`On this shift: journey (${dist.oneway_miles} mi) is within the ${threshold} mi threshold — no reimbursement from pharmacy on this shift.`);
      }
    }
  } else if (ext.travel_allowance_fixed) {
    lines.push(`**Mileage:** Fixed travel allowance of £${ext.travel_allowance_fixed} for the shift.`);
  } else {
    lines.push("**Mileage:** Not reimbursed by the pharmacy.");
  }

  if (dates.length === 1) {
    setState(conversationId, { phase: "awaiting_confirmation", pending: { ...template, shift_date: dates[0] } });
    return confirmShift(lines.join("\n"));
  }

  setState(conversationId, { phase: "awaiting_date_selection", template, dates });
  lines.push("");
  lines.push("**WHICH DATES DO YOU WANT TO LOG?**");
  dates.forEach((d, i) => lines.push(`${i + 1}. ${fmtDateWeekdayShort(d)}`));
  lines.push("");
  lines.push('Reply with the numbers you want (e.g. "1,3"), "all" to log every date, or "none" to skip.');
  return selectDates(lines.join("\n"), dates.map(fmtDateWeekdayShort));
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
  if (pending.break_duration_minutes) {
    lines.push(`**Break:** ${pending.break_duration_minutes} min ${pending.break_paid ? "paid" : "unpaid"}`);
  }
  if (result.mileage_miles) lines.push("", `**Mileage:** ${result.mileage_miles} mi auto-logged.`);
  else if (result.mileage_manual_needed) lines.push("", "Add mileage manually at locum1st.net/mileage");
  if (pending.travel_allowance_fixed) lines.push("", `**Travel allowance:** £${pending.travel_allowance_fixed} fixed.`);
  lines.push("", "View at locum1st.net/shifts");
  return plain(lines.join("\n"));
}

// Logs the same shift template across several selected dates — one
// /save-shift call per date, reusing the existing single-shift endpoint
// (there's no batch endpoint), then reports one combined confirmation.
async function handleSaveShifts(
  conversationId: string,
  userId: string,
  template: ShiftTemplate,
  dates: string[]
): Promise<BotReply> {
  setState(conversationId, { phase: "idle" });

  if (!dates.length) return plain("No dates selected. Send another shift offer whenever you're ready.");

  const results: Array<{ date: string; ok: boolean; mileage_miles?: number | null; mileage_manual_needed?: boolean }> = [];
  for (const date of dates) {
    try {
      const result = await botFetch<{
        ok?: boolean;
        mileage_miles?: number | null;
        mileage_manual_needed?: boolean;
      }>("/save-shift", {
        method: "POST",
        body: JSON.stringify({ auth_user_id: userId, pending_shift: { ...template, shift_date: date } }),
      });
      results.push({ date, ok: !!result.ok, mileage_miles: result.mileage_miles, mileage_manual_needed: result.mileage_manual_needed });
    } catch (err) {
      console.error(`[${conversationId}] Failed to save shift for ${date}:`, err);
      results.push({ date, ok: false });
    }
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  if (!succeeded.length) {
    return plain("Failed to log those shifts. Please try again or add them manually at locum1st.net/shifts");
  }

  const lines = [
    succeeded.length > 1 ? "**Shifts logged!**" : "**Shift logged!**",
    "",
    `**Pharmacy:** ${template.pharmacy_name}`,
    `**Time:** ${template.start_time}–${template.end_time}`,
    `**Rate:** £${template.hourly_rate}/hr`,
  ];
  if (template.break_duration_minutes) {
    lines.push(`**Break:** ${template.break_duration_minutes} min ${template.break_paid ? "paid" : "unpaid"}`);
  }
  lines.push("");
  for (const r of succeeded) {
    const mileageNote = r.mileage_miles
      ? ` — ${r.mileage_miles} mi auto-logged`
      : r.mileage_manual_needed
      ? " — add mileage manually"
      : "";
    lines.push(`✓ ${fmtDate(r.date)}${mileageNote}`);
  }

  const perShiftHours = paidHours(
    hoursDecimal(template.start_time, template.end_time),
    template.break_duration_minutes ?? 0,
    template.break_paid ?? false
  );
  const totalPay = (succeeded.length * perShiftHours * template.hourly_rate).toFixed(0);
  lines.push("", `**Total:** £${totalPay} across ${succeeded.length} shift${succeeded.length > 1 ? "s" : ""}`);
  if (template.travel_allowance_fixed) lines.push("", `**Travel allowance:** £${template.travel_allowance_fixed} fixed per shift.`);

  if (failed.length) {
    lines.push("", `Couldn't log ${failed.length} of them (${failed.map((f) => fmtDateShort(f.date)).join(", ")}) — try again or add manually.`);
  }
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

  // ── Awaiting date selection (multi-date shift offer) ─────────────────────
  if (state.phase === "awaiting_date_selection") {
    const lower = trimmed.toLowerCase();
    if (/^(none|cancel|skip)\b/.test(lower)) {
      setState(conversationId, { phase: "idle" });
      return plain("No shifts logged. Send another shift offer whenever you're ready.");
    }
    if (/^all\b/.test(lower)) {
      return handleSaveShifts(conversationId, userId, state.template, state.dates);
    }
    const indices = parseDateSelection(trimmed, state.dates.length);
    if (indices) {
      return handleSaveShifts(conversationId, userId, state.template, indices.map((i) => state.dates[i - 1]));
    }
    if (/\d/.test(trimmed)) {
      return plain(`I couldn't match that to the list. Reply with numbers from 1 to ${state.dates.length} (e.g. "1,3"), "all", or "none".`);
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
  if (!ext.shift_dates?.length) missing.push("the date");
  if (!ext.start_time) missing.push("the start time");
  if (!ext.end_time) missing.push("the end time");
  if (missing.length) {
    const named = missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
    return plain(`I couldn't work out ${named} for that shift — could you fill that in?`);
  }

  console.log(`[${conversationId}] Analysing: ${ext.pharmacy_name} ${ext.shift_dates!.join(",")} ${ext.start_time}-${ext.end_time}`);
  return handleShiftAnalysis(conversationId, userId, ext);
}
