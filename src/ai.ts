import OpenAI from "openai";
import { execute, query } from "./db.js";

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

const BOT_USER_ID = process.env.BOT_USER_ID;
if (!BOT_USER_ID) throw new Error("BOT_USER_ID is required");

const HISTORY_LIMIT = 5;

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

type PharmacyCandidate = { odsCode: string; name: string; address: string };

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
  // Flat list rather than one shared template + dates — covers both a single
  // pharmacy offered on several dates AND a multi-pharmacy broadcast, since
  // each candidate is already a fully-resolved shift in its own right.
  | { phase: "awaiting_date_selection"; candidates: PendingShift[] }
  // A postcode search for one group in the message came back with more than
  // one pharmacy and none was a confident name match — `resolved` carries
  // the matches already settled for earlier groups (undefined where a group
  // genuinely had no ODS hit) so handleShiftAnalysis can resume from where
  // it paused instead of re-querying groups that were already unambiguous.
  | {
      phase: "awaiting_pharmacy_selection";
      ext: ShiftExtraction;
      groups: ShiftGroup[];
      role: string | null;
      resolved: (PharmacyCandidate | undefined)[];
      candidates: PharmacyCandidate[];
    };

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
function selectPharmacy(text: string, candidates: Array<{ name: string; address: string }>): BotReply {
  return { text, metadata: { action: "select_pharmacy", candidates: candidates as unknown as JsonVal } };
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

// One pharmacy's dates/times within a multi-pharmacy offer — rate, break,
// mileage terms and pmr_system are shared across all groups and live only on
// ShiftExtraction (a broadcast rarely varies those per location).
type ShiftGroupRaw = {
  pharmacy_name?: string | null;
  pharmacy_postcode?: string | null;
  pharmacy_address?: string | null;
  shift_dates?: string[];
  start_time?: string | null;
  end_time?: string | null;
};

type ShiftGroup = {
  pharmacy_name?: string;
  pharmacy_postcode?: string;
  pharmacy_address?: string;
  shift_dates: string[];
  start_time: string;
  end_time: string;
};

// Classifies what the current message wants — replaces the old regex-based
// pre-checks (cancel/show/greeting), which were brittle against free-form
// phrasing and could false-positive on a shift offer that merely mentions
// "cancelled"/"shift" together (e.g. "previous rota cancelled, new shift
// below"). The model has full conversation history to work with, which the
// regexes never did.
type Intent = "shift_offer" | "cancel_shift" | "show_shifts" | "greeting" | "other";

type ShiftExtraction = {
  intent: Intent;
  // Set when the message offers shifts at more than one distinct pharmacy —
  // each with its own dates/times. When absent, the top-level
  // pharmacy_name/shift_dates/start_time/end_time fields below describe the
  // single (possibly multi-date) offer, as before.
  groups?: ShiftGroupRaw[];
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
  pmr_system?: string | null;
  // Plain-language summary of any open-ended "standing availability" mentioned
  // alongside concrete dates (e.g. "regular Fridays available", no end date
  // given) — kept separate from groups/shift_dates because there's no
  // principled end date to expand it to; see extractShift's prompt.
  recurring_availability?: string | null;
};

// Number of whole years dateStr's year needs to advance by to land on or
// after `today` (both YYYY-MM-DD) — 0 if it's already on/after today.
function yearsToRollForward(dateStr: string, today: string): number {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 0;
  let year = parseInt(m[1]!, 10);
  const monthDay = `${m[2]}-${m[3]}`;
  let years = 0;
  while (`${year}-${monthDay}` < today) {
    year++;
    years++;
  }
  return years;
}

function addYears(dateStr: string, years: number): string {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || years === 0) return dateStr;
  return `${parseInt(m[1]!, 10) + years}-${m[2]}-${m[3]}`;
}

// The LLM is asked to resolve a day+month with no year ("14 June") against
// "today", but it frequently just echoes the current year even when that
// date has already passed — offering a shift that already happened. Correct
// for that by rolling every date in the SAME group forward by the same
// number of years, but only when every date in the group is in the past. If
// even one sibling date in the same rota is already on/after today, the
// group is already anchored to the right year, and a date just a little
// behind it (e.g. "yesterday" in a rota that also covers today — an offer
// forwarded a day late) isn't evidence of a stale-year echo, so leave it
// alone rather than rolling that one date a full year ahead of its siblings.
function rollGroupDatesForward(dates: string[], today: string): string[] {
  const deltas = dates.map((d) => yearsToRollForward(d, today));
  if (deltas.some((delta) => delta === 0)) return dates;
  const maxDelta = Math.max(...deltas);
  return dates.map((d) => addYears(d, maxDelta));
}

// Resolves the message into one or more pharmacy groups, each with concrete
// dates/times — either the LLM's own `groups` (multi-pharmacy offer) or a
// single group built from the legacy flat fields (the common case). Drops
// any group missing dates/start/end rather than failing the whole message.
function normalizeGroups(ext: ShiftExtraction): ShiftGroup[] {
  const today = new Date().toISOString().slice(0, 10);
  const raw: ShiftGroupRaw[] = ext.groups?.length
    ? ext.groups
    : [{
        pharmacy_name: ext.pharmacy_name,
        pharmacy_postcode: ext.pharmacy_postcode,
        pharmacy_address: ext.pharmacy_address,
        shift_dates: ext.shift_dates,
        start_time: ext.start_time,
        end_time: ext.end_time,
      }];

  const groups: ShiftGroup[] = [];
  for (const g of raw) {
    if (!g.shift_dates?.length || !g.start_time || !g.end_time) continue;
    groups.push({
      pharmacy_name: g.pharmacy_name ?? undefined,
      pharmacy_postcode: g.pharmacy_postcode ?? undefined,
      pharmacy_address: g.pharmacy_address ?? undefined,
      shift_dates: rollGroupDatesForward(g.shift_dates, today),
      start_time: g.start_time,
      end_time: g.end_time,
    });
  }
  return groups;
}

type HistoryTurn = { role: "user" | "assistant"; content: string };

// Last few messages in the conversation (either side), oldest first — lets
// extractShift piece together shift details split across messages ("Boots
// Manchester" then, separately, "9-5 Tuesday, £24/hr") instead of treating
// each incoming message as a standalone, context-free offer.
async function fetchRecentHistory(conversationId: string, currentMessageId: string): Promise<HistoryTurn[]> {
  const rows = await query<{ sender_id: string; text: string }>(
    `SELECT sender_id, text FROM locum1st.messages
     WHERE conversation_id = $1 AND id <> $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [conversationId, currentMessageId, HISTORY_LIMIT]
  );
  return rows.reverse().map((m) => ({
    role: m.sender_id === BOT_USER_ID ? "assistant" : "user",
    content: m.text,
  }));
}

async function extractShift(text: string, history: HistoryTurn[]): Promise<ShiftExtraction> {
  const today = new Date().toISOString().slice(0, 10);
  const todayWeekday = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long" });
  const res = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    // A multi-group broadcast (several pharmacies, or one pharmacy with
    // several one-off dates) can easily need more than a couple hundred
    // tokens of JSON — 400 was tight enough that real broadcasts got cut off
    // mid-string, which fails JSON.parse and silently drops to intent
    // "other" with no explanation to the user.
    max_tokens: 1000,
    messages: [
      {
        role: "system",
        content: `You're the message handler for a locum pharmacist's shift-tracking bot. Classify the CURRENT message's intent and, if it's a shift offer, extract its details. Return JSON.
Recent conversation history is provided for context (e.g. shift details split across several messages, or a follow-up like "actually make it 8am") — the CURRENT message is the last one; prior ones are context only, do not re-report a shift that was already fully extracted and confirmed earlier unless the current message adds to or changes it.
First decide "intent" — one of:
- "shift_offer": the message is offering, describing, or forwarding one or more concrete shifts at a pharmacy — a broadcast, a rota, or a single shift. This includes messages that also happen to mention words like "cancelled" or "removed" in passing (e.g. "previous rota cancelled, new shift below") — that's still a shift offer, not a cancel request.
- "cancel_shift": the sender (the locum) wants to cancel/delete/remove a shift THEY have already logged with Locum1st — not a shift offer describing some other change.
- "show_shifts": the sender wants to see their own logged/upcoming shifts.
- "greeting": a greeting, or a general "what can you do"/help question, with no specific shift or account action attached.
- "other": anything else that doesn't fit the above — chit-chat, an unrelated question, or unclear intent.
Only fill in the shift fields below (groups/pharmacy_name/shift_dates/etc.) when intent is "shift_offer" — leave them null/omitted otherwise.
Today is ${today}, a ${todayWeekday}. Convert relative or informal dates to YYYY-MM-DD using today as the reference — "tomorrow", "next Tue", "this Sat", and bare day names like "Wednesday" should all resolve to a specific date, not be left null just because they're not already in YYYY-MM-DD form. Work out the date-to-weekday mapping carefully from today's weekday above rather than guessing — a date you output must actually fall on the weekday named in the text, if one was given. A day+month with no year (e.g. "14 June") means the NEXT time that date occurs — if that date has already passed this year, it means next year, not this year.
Parse informal or 12-hour times too — "9am", "9:00am", "09:00", "nine o'clock", "9-5" (meaning 09:00-17:00) should all convert to 24h HH:MM.
If only a duration is given alongside a start time (e.g. "8 hour shift from 9am"), compute end_time yourself from start_time + duration.
If end_time would be earlier than start_time, that's an overnight shift spanning into the next day — extract the times as given rather than treating them as invalid.
If the SAME shift pattern (same pharmacy, times, and rate) is offered across multiple dates — a rota, a list of days ("Mon/Wed/Fri"), or a phrase like "every day next week" — include every date in shift_dates, not just the first one you see.
Distinguish this from OPEN-ENDED standing availability with no end date — e.g. "Regular Fridays 8.30-6.15 available", "every Saturday going forward". Do NOT invent an arbitrary number of future dates for these (you have no principled way to know how many weeks the sender means, and guessing produces wrong, made-up shifts). Instead, leave those weekdays out of shift_dates/groups entirely and summarise them in "recurring_availability" instead, e.g. "Regular Fridays 08:30-18:15 and Saturdays 08:30-14:30". Only the concrete, specifically-dated shifts in the message go into shift_dates/groups.
If the message offers shifts at MORE THAN ONE DISTINCT PHARMACY (different names/addresses, each with its own date(s) and/or times — e.g. a multi-branch broadcast like "13 July: Prescot Road ... / 30 July: Moreton ..."), put one object per pharmacy in the "groups" array instead of using the top-level pharmacy_name/shift_dates/start_time/end_time fields — leave those top-level fields null in that case. Each group needs its own pharmacy_name/pharmacy_postcode/pharmacy_address/shift_dates/start_time/end_time. Do NOT create a group per date for a SINGLE pharmacy's rota — that's still just shift_dates on one group (or the top-level fields, if there's only one pharmacy overall).
hourly_rate, shift_type, break/mileage/pmr_system fields are shared across every group in the same message — a broadcast to multiple branches essentially never varies pay/break/mileage terms per location — so only set those once at the top level, never per-group.
Fields:
- intent: "shift_offer" | "cancel_shift" | "show_shifts" | "greeting" | "other" — see above
- groups: array | null — see above; each entry has pharmacy_name, pharmacy_postcode, pharmacy_address, shift_dates, start_time, end_time (same shapes as the top-level fields below). Omit or leave null/empty when the offer is a single pharmacy.
- pharmacy_name: string | null (only when NOT using groups)
- pharmacy_postcode: string | null (only when NOT using groups)
- pharmacy_address: string | null (only when NOT using groups)
- shift_dates: array of "YYYY-MM-DD" strings (only when NOT using groups) — every date this shift pattern applies to (usually just one, but see above)
- start_time: "HH:MM" | null (24h, only when NOT using groups)
- end_time: "HH:MM" | null (24h, only when NOT using groups)
- hourly_rate: number | null
- shift_type: "standard" | "overnight" | "bank_holiday"
- break_duration_minutes: number | null (length of any lunch/rest break mentioned, in minutes)
- break_paid: boolean (true only if the text says the break IS paid; default false — most breaks are unpaid unless stated otherwise)
- mileage_paid: boolean (true ONLY for a per-mile rate, e.g. "45p a mile" — false if travel is a flat/fixed amount)
- mileage_pence_per_mile: number | null (only set when there's a per-mile rate)
- mileage_threshold_miles: number | null (miles each way the locum covers themselves before per-mile reimbursement starts)
- mileage_cap_miles: number | null (miles each way beyond which the pharmacy stops reimbursing per-mile travel, e.g. "up to 30 miles") — only relevant with a per-mile rate
- travel_allowance_fixed: number | null (a flat £ travel allowance for the whole shift, e.g. "plus £20 travel" — mutually exclusive with a per-mile rate; leave mileage_paid false and mileage_pence_per_mile null when this is set)
- pmr_system: string | null — ONLY set this if the text explicitly names the pharmacy's PMR (patient medication record) system, e.g. "EMIS", "ProScript Connect", "Titan", "Pharmacy Manager", "Positive Solutions", "Nexphase". Normalise obvious spelling/case variants to the common name. Do not guess — leave null if it isn't mentioned.
- recurring_availability: string | null — see above; a short human-readable note about any open-ended standing availability, only when the message mentions one. Leave null otherwise.`,
      },
      ...history,
      { role: "user", content: text },
    ],
  });
  const choice = res.choices[0];
  try {
    return JSON.parse(choice?.message?.content ?? "{}") as ShiftExtraction;
  } catch (err) {
    console.error(
      `Failed to parse shift extraction JSON (finish_reason=${choice?.finish_reason}):`,
      err,
      choice?.message?.content
    );
    return { intent: "other" };
  }
}

// ─── Rate & verdict logic ─────────────────────────────────────────────────────

// Area-based benchmark from Locum1st's /market-rate endpoint (crowd-sourced
// postings in shared.market_shift_postings, matched on area + workload tier +
// bank-holiday/same-day-emergency category). Falls back to a flat default
// when the endpoint itself has too little data, and to the same default here
// if the call fails outright — never falls back to a single pharmacy's history.
type MarketRate = {
  benchmarkRate: number;
  sampleSize: number;
  source: "area_tier_match" | "area_relaxed_tier" | "default_fallback";
  tier: "busy" | "moderate" | "quieter" | null;
  isBankHoliday: boolean;
  isSameDayEmergency: boolean;
};

function tierOf(avgItems: number | null): "busy" | "moderate" | "quieter" | null {
  if (avgItems == null) return null;
  if (avgItems > 8000) return "busy";
  if (avgItems > 4000) return "moderate";
  return "quieter";
}

// locum1st.verification_roles has a separate 'pharmacist' key (an employed,
// non-locum pharmacist) alongside 'locum_pharmacist' — but any shift someone
// forwards to this bot is by definition locum work, regardless of which of
// those two the sender's profile says, so fold 'pharmacist' into
// 'locum_pharmacist' for every rate/benchmark/display purpose below. Other
// roles (dispenser, technician, ACT) already map to themselves.
function normalizeRole(role: string | null): string | null {
  return role === "pharmacist" ? "locum_pharmacist" : role;
}

// Same role_type values as locum1st.profiles.role_type. Pharmacist vs
// technician/ACT/dispenser rates differ enormously, so every rate suggestion
// and verdict needs to be anchored to the right one.
const ROLE_LABELS: Record<string, string> = {
  locum_pharmacist: "Locum Pharmacist",
  pharmacy_technician: "Pharmacy Technician",
  act: "Accuracy Checking Technician",
  dispenser: "Dispenser",
};

// Mirrors the server-side default in Locum1st's /api/bot/market-rate — used
// only when that HTTP call itself fails outright, so this local fallback
// never gives a wildly pharmacist-shaped number to a technician/dispenser.
const FALLBACK_RATES: Record<string, { busy: number; other: number }> = {
  locum_pharmacist: { busy: 30, other: 28 },
  pharmacy_technician: { busy: 18, other: 16 },
  act: { busy: 19, other: 17 },
  dispenser: { busy: 14, other: 12 },
};

async function fetchMarketRate(
  postcode: string | undefined,
  area: string | undefined,
  date: string,
  avgItems: number | null,
  role: string | null
): Promise<MarketRate> {
  const params = new URLSearchParams({ date });
  if (postcode) params.set("postcode", postcode);
  if (area) params.set("area", area);
  if (avgItems != null) params.set("items", String(avgItems));
  if (role) params.set("role", role);
  try {
    return await botFetch<MarketRate>(`/market-rate?${params}`);
  } catch (err) {
    console.error("Market rate lookup failed, using flat fallback:", err);
    const tier = tierOf(avgItems);
    const rates = (role && FALLBACK_RATES[role]) || FALLBACK_RATES.locum_pharmacist!;
    return {
      benchmarkRate: tier === "busy" ? rates.busy : rates.other,
      sampleSize: 0,
      source: "default_fallback",
      tier,
      isBankHoliday: false,
      isSameDayEmergency: false,
    };
  }
}

function verdict(rate: number, benchmark: number): string {
  if (rate >= benchmark + 1) return "Worth taking";
  if (rate >= benchmark - 1) return "Fair rate";
  if (rate >= benchmark - 3) return "Consider carefully";
  return "Below market rate";
}

function verdictReason(rate: number, benchmark: number, tier: "busy" | "moderate" | "quieter" | null): string {
  const forTier = tier ? ` for a ${tier} pharmacy` : "";
  const diff = rate - benchmark;
  if (diff >= 1) return `Paying above the area's market rate${forTier}.`;
  if (diff >= -1) return `Rate matches the area's market rate${forTier}.`;
  if (diff >= -3) return `Rate is a little low${forTier} (market ~£${benchmark}/hr). Negotiate if you can.`;
  return `Rate is well below market${forTier}. Market rate here is ~£${benchmark}/hr.`;
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

// True only for text that actually looks like an attempted (if invalid) list
// reply — short, and nothing but digits/commas/hyphens/whitespace once "and"
// and ordinal suffixes are stripped. A freshly forwarded shift offer also
// contains digits (times, dates, rate) but is much longer and full of
// letters, so it won't match — it should fall through to fresh extraction
// instead of being misread as a bad reply to a stale prompt.
function looksLikeFailedSelection(input: string): boolean {
  if (input.length > 40) return false;
  const stripped = input
    .replace(/\b(and|the)\b/gi, ",")
    .replace(/(st|nd|rd|th)\b/gi, "");
  return /\d/.test(stripped) && /^[\d,\-\s]+$/.test(stripped);
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

// Best-effort, fire-and-forget: appends one row to the crowd-sourced
// pharmacy/ODS/PMR observation log (shared.pharmacy_pmr_observations,
// Locum1st's instrumentation.ts) whenever a forwarded shift offer names a
// PMR system — regardless of whether the locum goes on to log the shift.
// Purely a background data asset for future use; must never affect the
// analysis reply, so failures are only logged, never thrown.
function logPmrObservation(
  conversationId: string,
  userId: string,
  pharmacyName: string,
  odsCode: string | undefined,
  pharmacyAddress: string | undefined,
  pmrSystem: string
): void {
  execute(
    `INSERT INTO shared.pharmacy_pmr_observations
       (pharmacy_name, ods_code, pmr_system, pharmacy_address, reported_by_auth_user_id, conversation_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [pharmacyName, odsCode ?? null, pmrSystem, pharmacyAddress ?? null, userId, conversationId]
  ).catch((err) => {
    console.error(`[${conversationId}] Failed to log PMR observation:`, err);
  });
}

// ─── Pharmacy resolution ────────────────────────────────────────────────────

function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Loose match between an ODS-registered name and the (often informal) name
// given in a shift offer — e.g. "K's Chemist" vs a formal ODS name like "K S
// CHEMIST LTD" — used only to auto-resolve an otherwise-ambiguous multi-hit
// postcode search. Deliberately conservative (a substring check on fully
// punctuation/space-stripped text, gated on a minimum length) since a false
// positive here means silently picking the wrong pharmacy; anything that
// doesn't clear this bar falls through to asking the user directly.
function isCloseNameMatch(candidateName: string, offeredName: string): boolean {
  const a = normalizeForMatch(candidateName);
  const b = normalizeForMatch(offeredName);
  return a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
}

type PharmacyResolution =
  | { status: "matched"; match: PharmacyCandidate }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: PharmacyCandidate[] };

// Looks up the pharmacy for one group. Sends the pharmacy name and its
// area/postcode as SEPARATE params rather than pre-joined into one string —
// Locum1st's /pharmacy route has two fallback tiers beyond the
// combined-string search (name-only, then per-significant-word), but both
// are gated on receiving a distinct `name` param (it can't safely undo a
// join to try the name alone, since a pharmacy's formal name can itself
// contain a place name). When the postcode/name search comes back with more
// than one hit and none is a close match to the offered name, this reports
// "ambiguous" instead of guessing — the caller decides whether to ask the
// user or fall back to unmatched.
async function resolvePharmacy(conversationId: string, group: ShiftGroup): Promise<PharmacyResolution> {
  const pharmacyName = group.pharmacy_name?.trim() || undefined;
  const pharmacyArea = [group.pharmacy_postcode, group.pharmacy_address].filter(Boolean).join(" ").trim() || undefined;
  if (!pharmacyName && !pharmacyArea) return { status: "not_found" };

  const params = new URLSearchParams();
  if (pharmacyName) {
    params.set("name", pharmacyName);
    if (pharmacyArea) params.set("area", pharmacyArea);
  } else {
    // No pharmacy name at all — only postcode/address to go on. Send as
    // `q`, not `name`: the route's per-word fallback tier only runs when a
    // caller sends an explicit `name`, and area/postcode text must never
    // reach that tier — a place name inside it could false-match an
    // unrelated pharmacy that merely shares the locality.
    params.set("q", pharmacyArea!);
  }

  let results: PharmacyCandidate[] = [];
  try {
    // Locum1st's route always responds with a { results } shape now, but
    // stay null-safe here too rather than depending on that alone.
    const pharmacyData = await botFetch<{ results?: PharmacyCandidate[] } | null>(`/pharmacy?${params}`);
    results = pharmacyData?.results ?? [];
  } catch (err) {
    console.error(`[${conversationId}] Pharmacy lookup failed for "${params}":`, err);
    return { status: "not_found" };
  }

  if (!results.length) return { status: "not_found" };
  if (results.length === 1) {
    // A lone hit is NOT automatically trustworthy — Locum1st's per-word
    // fallback tier matches on any single significant word in the offered
    // name, and a pharmacy legitimately named after its own town (e.g.
    // "Ashbourne Pharmacy") can pull back a same-substring but totally
    // unrelated pharmacy elsewhere in the country (observed live: "Olive
    // Pharmacy Ashbourne" in Keighley, matched purely on "Ashbourne", for a
    // Derbyshire postcode). Only skip this check when there's no name to
    // validate against at all (a pure postcode/area search).
    const only = results[0]!;
    if (!pharmacyName || isCloseNameMatch(only.name, pharmacyName)) {
      return { status: "matched", match: only };
    }
    return { status: "ambiguous", candidates: results };
  }
  if (pharmacyName) {
    const close = results.filter((r) => isCloseNameMatch(r.name, pharmacyName));
    if (close.length === 1) return { status: "matched", match: close[0]! };
  }
  return { status: "ambiguous", candidates: results };
}

// ─── Sub-handlers ─────────────────────────────────────────────────────────────

// Runs the full workload / distance / market-rate / verdict analysis for ONE
// pharmacy group, given its already-resolved ODS match (or undefined if none
// was found). rate/break/mileage/pmr_system come from `ext` (shared across
// every group in the message); everything pharmacy- and date-specific comes
// from `group`. Returns one PendingShift candidate per date in the group,
// plus the formatted summary block for that group.
async function analyzeGroup(
  conversationId: string,
  userId: string,
  ext: ShiftExtraction,
  group: ShiftGroup,
  role: string | null,
  match: PharmacyCandidate | undefined
): Promise<{ candidates: PendingShift[]; lines: string[] }> {
  const pharmacyNameForLog = match?.name ?? group.pharmacy_name;
  if (ext.pmr_system && pharmacyNameForLog) {
    logPmrObservation(
      conversationId,
      userId,
      pharmacyNameForLog,
      match?.odsCode,
      match?.address ?? group.pharmacy_address,
      ext.pmr_system
    );
  }

  type HistoryMonth = { items: number; pharmacyFirstTotal: number; nms: number; bpChecks: number };
  type HistoryData = { months?: HistoryMonth[] };
  let history: HistoryData = {};
  if (match?.odsCode) {
    try {
      // data1st has no record at all for plenty of pharmacies — Locum1st's
      // route responds with { months: [] } for that (a normal outcome, not
      // a failure), but stay null-safe here too rather than depending on
      // that alone; a bare `history.months` on a null response would throw
      // and take down the whole analysis instead of just showing "no data".
      const data = await botFetch<HistoryData | null>(`/pharmacy/history?ods=${match.odsCode}`);
      history = data ?? {};
    } catch (err) {
      console.error(`[${conversationId}] Pharmacy history lookup failed for ODS ${match.odsCode}:`, err);
    }
  }

  const months = (history.months ?? []).slice(0, 6);
  const avg = (key: keyof HistoryMonth) =>
    months.length ? Math.round(months.reduce((s, m) => s + (m[key] ?? 0), 0) / months.length) : null;

  const avgItems = avg("items");
  const avgPF = avg("pharmacyFirstTotal");
  const avgNms = avg("nms");
  const avgBp = avg("bpChecks");

  type DistData = { oneway_miles?: number; return_miles?: number; duration_text?: string; error?: string };
  // Failsafe order: a confirmed ODS address is the most precise, but once
  // there's no match, the postcode the sender actually typed geocodes far
  // more reliably than an informal address string ("Clifton Rd, Ashbourne")
  // on its own — so it comes before pharmacy_address here, not after.
  const toAddr = match?.address ?? group.pharmacy_postcode ?? group.pharmacy_address ?? group.pharmacy_name ?? "";
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

  const rawHours = hoursDecimal(group.start_time, group.end_time);
  const breakMinutes = ext.break_duration_minutes ?? 0;
  const breakPaid = ext.break_paid ?? false;
  const hours = paidHours(rawHours, breakMinutes, breakPaid);
  const shiftType = ext.shift_type ?? "standard";

  const market = await fetchMarketRate(
    group.pharmacy_postcode,
    match?.address ?? group.pharmacy_address,
    group.shift_dates[0]!,
    avgItems,
    role
  );
  // Market comparison doesn't classify by overnight (only area/tier/bank-holiday/
  // same-day-emergency), so that bump still applies on top of the benchmark.
  const benchmark = market.benchmarkRate + (shiftType === "overnight" ? 3 : 0);

  const rateProvided = ext.hourly_rate != null;
  const rate = ext.hourly_rate ?? benchmark;
  const totalPay = (rate * hours).toFixed(0);

  const template: ShiftTemplate = {
    pharmacy_name: match?.name ?? group.pharmacy_name ?? "Unknown",
    pharmacy_address: match?.address ?? group.pharmacy_address ?? group.pharmacy_postcode,
    pharmacy_ods_code: match?.odsCode,
    start_time: group.start_time,
    end_time: group.end_time,
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
  const dates = group.shift_dates;
  const candidates: PendingShift[] = dates.map((d) => ({ ...template, shift_date: d }));

  const roleLabel = role ? ROLE_LABELS[role] ?? role : null;

  const lines: string[] = [];
  lines.push(`**Pharmacy:** ${match?.name ?? group.pharmacy_name ?? "Unknown"} (${match?.odsCode ?? "ODS not found"})`);
  if (match?.address) lines.push(`**Address:** ${match.address}`);
  if (roleLabel) lines.push(`**Role:** ${roleLabel}`);
  const hoursLabel = hours % 1 === 0 ? hours : hours.toFixed(1);
  const breakNote = breakMinutes > 0 ? ` — ${breakMinutes} min ${breakPaid ? "paid" : "unpaid"} break` : "";
  if (dates.length === 1) {
    lines.push(`**Date:** ${fmtDate(dates[0])} | ${group.start_time}–${group.end_time} (${hoursLabel} hrs paid${breakNote})`);
  } else {
    lines.push(`**Time:** ${group.start_time}–${group.end_time} (${hoursLabel} hrs paid${breakNote}) — offered on ${dates.length} dates, see below`);
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
    lines.push("**WORKLOAD:** No dispensing data available for this pharmacy yet — can't estimate typical volume here.");
  }

  lines.push("");

  const roleForNote = roleLabel ? `${roleLabel} ` : "";
  const marketNote = market.sampleSize > 0
    ? ` (based on ${market.sampleSize} comparable ${roleForNote}posting${market.sampleSize === 1 ? "" : "s"} in the area)`
    : "";

  if (rateProvided) {
    lines.push(`**VERDICT:** ${verdict(rate, benchmark)}`);
    lines.push(verdictReason(rate, benchmark, market.tier) + marketNote);
  } else {
    lines.push(`**RATE SUGGESTION:** £${benchmark}/hr${marketNote}`);
    lines.push(
      avgItems != null
        ? `Based on ${avgItems.toLocaleString()} items/month avg and nearby market postings. Counter at or above this rate.`
        : `Based on nearby market postings. Counter at or above this rate.`
    );
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

  return { candidates, lines };
}

// Orchestrates one or more pharmacy groups from the same message. Resolves
// each group's pharmacy first (in order) before running any of the heavier
// workload/distance/rate analysis — if a group's postcode search comes back
// ambiguous, this pauses immediately and asks the user rather than guessing
// or running (and discarding) analysis for groups that come after it.
// `resolved` is the set of matches already settled for the groups at the
// front of the list — non-empty only when resuming after the user answered
// an ambiguous-pharmacy prompt for an earlier call on the same message.
// A single group renders exactly as a standalone shift always has; multiple
// groups (a multi-branch broadcast) get numbered sub-headers and a combined
// selection list spanning every date at every pharmacy.
async function handleShiftAnalysis(
  conversationId: string,
  userId: string,
  ext: ShiftExtraction,
  groups: ShiftGroup[],
  role: string | null,
  resolved: (PharmacyCandidate | undefined)[] = []
): Promise<BotReply> {
  const matches: (PharmacyCandidate | undefined)[] = [...resolved];
  for (let i = matches.length; i < groups.length; i++) {
    const group = groups[i]!;
    const resolution = await resolvePharmacy(conversationId, group);
    if (resolution.status === "ambiguous") {
      setState(conversationId, {
        phase: "awaiting_pharmacy_selection",
        ext,
        groups,
        role,
        resolved: matches,
        candidates: resolution.candidates,
      });
      const label = group.pharmacy_name ? `"${group.pharmacy_name}"` : "that pharmacy";
      const area = group.pharmacy_postcode ?? group.pharmacy_address ?? "that area";
      const intro = resolution.candidates.length === 1
        ? `Found a pharmacy near ${area}, but the name doesn't look like a confident match for ${label} — is this it?`
        : `Found ${resolution.candidates.length} pharmacies matching ${area} and couldn't tell which one you meant.`;
      const lines = [
        `**Which pharmacy is ${label}?**`,
        "",
        intro,
        "",
        ...resolution.candidates.map((c, idx) => `${idx + 1}. **${c.name}** — ${c.address}`),
        "",
        'Reply with a number, or "none" if none of these are right.',
      ];
      return selectPharmacy(
        lines.join("\n"),
        resolution.candidates.map((c) => ({ name: c.name, address: c.address }))
      );
    }
    matches.push(resolution.status === "matched" ? resolution.match : undefined);
  }

  const analyzed = await Promise.all(groups.map((group, i) => analyzeGroup(conversationId, userId, ext, group, role, matches[i])));
  const candidates = analyzed.flatMap((a) => a.candidates);

  const lines: string[] = [];
  if (groups.length === 1) {
    lines.push("**SHIFT SUMMARY**", "");
    lines.push(...analyzed[0]!.lines);
  } else {
    lines.push(`**${groups.length} SHIFTS AVAILABLE**`);
    analyzed.forEach((a, i) => {
      lines.push("", `**${i + 1}. ${groups[i]!.pharmacy_name ?? "Pharmacy"}**`, ...a.lines);
    });
  }

  if (ext.recurring_availability) {
    lines.push("", `**Also noted:** ${ext.recurring_availability} — send a specific date when one comes up and I'll analyse it.`);
  }

  if (candidates.length === 1) {
    setState(conversationId, { phase: "awaiting_confirmation", pending: candidates[0]! });
    return confirmShift(lines.join("\n"));
  }

  setState(conversationId, { phase: "awaiting_date_selection", candidates });
  lines.push("");
  lines.push("**WHICH SHIFTS DO YOU WANT TO LOG?**");
  candidates.forEach((c, i) =>
    lines.push(`${i + 1}. ${c.pharmacy_name} — ${fmtDateWeekdayShort(c.shift_date)}, ${c.start_time}–${c.end_time}`)
  );
  lines.push("");
  lines.push('Reply with the numbers you want (e.g. "1,3"), "all" to log every shift, or "none" to skip.');
  return selectDates(
    lines.join("\n"),
    candidates.map((c) => `${fmtDateWeekdayShort(c.shift_date)} – ${c.pharmacy_name}`)
  );
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

// Logs a flat list of already-resolved shift candidates — one /save-shift
// call per candidate, reusing the existing single-shift endpoint (there's no
// batch endpoint). Candidates may span different pharmacies/times/rates (a
// multi-branch broadcast), not just different dates of the same template, so
// each result line and the total are computed per-candidate rather than
// assuming one shared template.
async function handleSaveShifts(
  conversationId: string,
  userId: string,
  candidates: PendingShift[]
): Promise<BotReply> {
  setState(conversationId, { phase: "idle" });

  if (!candidates.length) return plain("No shifts selected. Send another shift offer whenever you're ready.");

  const results: Array<{ candidate: PendingShift; ok: boolean; mileage_miles?: number | null; mileage_manual_needed?: boolean }> = [];
  for (const candidate of candidates) {
    try {
      const result = await botFetch<{
        ok?: boolean;
        mileage_miles?: number | null;
        mileage_manual_needed?: boolean;
      }>("/save-shift", {
        method: "POST",
        body: JSON.stringify({ auth_user_id: userId, pending_shift: candidate }),
      });
      results.push({ candidate, ok: !!result.ok, mileage_miles: result.mileage_miles, mileage_manual_needed: result.mileage_manual_needed });
    } catch (err) {
      console.error(`[${conversationId}] Failed to save shift for ${candidate.shift_date} at ${candidate.pharmacy_name}:`, err);
      results.push({ candidate, ok: false });
    }
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  if (!succeeded.length) {
    return plain("Failed to log those shifts. Please try again or add them manually at locum1st.net/shifts");
  }

  const lines = [succeeded.length > 1 ? "**Shifts logged!**" : "**Shift logged!**", ""];
  let totalPay = 0;
  for (const r of succeeded) {
    const c = r.candidate;
    const perShiftHours = paidHours(
      hoursDecimal(c.start_time, c.end_time),
      c.break_duration_minutes ?? 0,
      c.break_paid ?? false
    );
    totalPay += perShiftHours * c.hourly_rate;
    const mileageNote = r.mileage_miles
      ? ` — ${r.mileage_miles} mi auto-logged`
      : r.mileage_manual_needed
      ? " — add mileage manually"
      : "";
    lines.push(`✓ **${c.pharmacy_name}** — ${fmtDate(c.shift_date)}, ${c.start_time}–${c.end_time}, £${c.hourly_rate}/hr${mileageNote}`);
  }

  lines.push("", `**Total:** £${totalPay.toFixed(0)} across ${succeeded.length} shift${succeeded.length > 1 ? "s" : ""}`);

  const fixedAllowances = succeeded
    .map((r) => r.candidate.travel_allowance_fixed)
    .filter((a): a is number => !!a);
  if (fixedAllowances.length) {
    const totalAllowance = fixedAllowances.reduce((s, a) => s + a, 0);
    lines.push("", `**Travel allowance:** £${totalAllowance.toFixed(0)} total (fixed per shift).`);
  }

  if (failed.length) {
    lines.push(
      "",
      `Couldn't log ${failed.length} of them (${failed.map((f) => `${f.candidate.pharmacy_name} ${fmtDateShort(f.candidate.shift_date)}`).join(", ")}) — try again or add manually.`
    );
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
  text: string,
  messageId: string
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

  // ── Awaiting date selection (multi-shift offer) ──────────────────────────
  if (state.phase === "awaiting_date_selection") {
    const lower = trimmed.toLowerCase();
    if (/^(none|cancel|skip)\b/.test(lower)) {
      setState(conversationId, { phase: "idle" });
      return plain("No shifts logged. Send another shift offer whenever you're ready.");
    }
    if (/^all\b/.test(lower)) {
      return handleSaveShifts(conversationId, userId, state.candidates);
    }
    const indices = parseDateSelection(trimmed, state.candidates.length);
    if (indices) {
      return handleSaveShifts(conversationId, userId, indices.map((i) => state.candidates[i - 1]!));
    }
    if (looksLikeFailedSelection(trimmed)) {
      return plain(`I couldn't match that to the list. Reply with numbers from 1 to ${state.candidates.length} (e.g. "1,3"), "all", or "none".`);
    }
    setState(conversationId, { phase: "idle" });
  }

  // ── Awaiting pharmacy selection (ambiguous postcode match) ───────────────
  if (state.phase === "awaiting_pharmacy_selection") {
    const lower = trimmed.toLowerCase();
    if (/^(none|neither|skip)\b/.test(lower)) {
      return handleShiftAnalysis(conversationId, userId, state.ext, state.groups, state.role, [...state.resolved, undefined]);
    }
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= state.candidates.length) {
      return handleShiftAnalysis(
        conversationId, userId, state.ext, state.groups, state.role,
        [...state.resolved, state.candidates[num - 1]]
      );
    }
    if (/^\d+$/.test(trimmed)) {
      return plain(`That number isn't in the list. Reply with a number from 1 to ${state.candidates.length}, or "none".`);
    }
    setState(conversationId, { phase: "idle" });
  }

  // ── Pro check ───────────────────────────────────────────────────────────
  const userStatus = await botFetch<{ linked?: boolean; pro?: boolean; role_type?: string | null }>(
    `/user?auth_user_id=${encodeURIComponent(userId)}`
  );
  if (!userStatus?.linked || !userStatus?.pro) {
    return plain("Shift analysis is a Locum1st Pro feature. Upgrade to Pro at locum1st.net/upgrade to use the bot.");
  }
  const role = normalizeRole(userStatus.role_type ?? null);

  // ── Classify intent and, if relevant, extract the shift offer ───────────
  const history = await fetchRecentHistory(conversationId, messageId);
  const ext = await extractShift(text, history);

  if (ext.intent === "cancel_shift") {
    return handleListShiftsForDelete(conversationId, userId);
  }

  if (ext.intent === "show_shifts") {
    const data = await botFetch<{ shifts?: Shift[] }>(`/shifts?auth_user_id=${encodeURIComponent(userId)}`);
    if (!data.shifts?.length) return plain("You have no recent shifts logged.");
    return plain(data.shifts
      .map((s, i) => `${i + 1}. **${s.pharmacy_name}** — ${fmtDate(s.shift_date)}, ${s.start_time}–${s.end_time}, £${s.hourly_rate}/hr`)
      .join("\n"));
  }

  if (ext.intent === "greeting") {
    return plain("Send me a shift offer and I'll analyse it:\n\n**Rate** vs workload\n**Driving distance** from your home\n**Verdict** on whether the pay is fair\n\nThen log it to your shifts if you want to accept it.");
  }

  if (ext.intent !== "shift_offer") {
    return plain("I'm here to analyse shifts and log them. Forward a shift offer to get started.");
  }

  const groups = normalizeGroups(ext);
  if (!groups.length) {
    // A message can be nothing but open-ended standing availability ("Regular
    // Fridays available") with no concrete dates at all — that's not a
    // missing-field error, there's just nothing bookable to analyse yet.
    if (ext.recurring_availability) {
      return plain(`Noted: ${ext.recurring_availability}. Send me a specific date when one comes up and I'll analyse it.`);
    }
    // Single-pharmacy case (the common one): name exactly which field is missing,
    // same as before groups existed. A multi-pharmacy offer with an incomplete
    // group gets a generic message instead — rarer, and "which group" is less
    // meaningful to surface than "which field".
    if (!ext.groups?.length) {
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
    }
    return plain("I couldn't work out the date, start time and end time for that shift — could you fill that in?");
  }

  console.log(
    `[${conversationId}] Analysing ${groups.length} group(s): ` +
      groups.map((g) => `${g.pharmacy_name ?? "?"} ${g.shift_dates.join(",")} ${g.start_time}-${g.end_time}`).join(" | ")
  );
  return handleShiftAnalysis(conversationId, userId, ext, groups, role);
}
