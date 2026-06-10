import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const BEARER = process.env.BOT_API_BEARER ?? "7011c8df892dc963da4ee679c39b9470d966490369ad001c475478615438c58f";
const BASE = process.env.BOT_API_BASE ?? "https://locum1st.y-hs.net/api/bot";

// ─── Types ───────────────────────────────────────────────────────────────────

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

const states = new Map<string, State>();

// ─── API helpers ──────────────────────────────────────────────────────────────

async function botFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${BEARER}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  return res.json() as Promise<T>;
}

// ─── Shift extraction via LLM ─────────────────────────────────────────────────

type ShiftExtraction = {
  is_shift_offer: boolean;
  pharmacy_name?: string;
  pharmacy_postcode?: string;
  pharmacy_address?: string;
  shift_date?: string;       // YYYY-MM-DD
  start_time?: string;       // HH:MM
  end_time?: string;         // HH:MM
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
        content: `You extract shift offer details from text. Return JSON.
Today is ${today}. Convert relative dates ("next Monday", "tomorrow") to YYYY-MM-DD.
Fields:
- is_shift_offer: boolean — true only if the text is clearly a shift offer
- pharmacy_name: string | null
- pharmacy_postcode: string | null — UK postcode only if explicitly in the text
- pharmacy_address: string | null — full address string if available
- shift_date: "YYYY-MM-DD" | null
- start_time: "HH:MM" | null — 24h
- end_time: "HH:MM" | null — 24h
- hourly_rate: number | null — null if no rate is mentioned
- shift_type: "standard" | "overnight" | "bank_holiday"
- mileage_paid: boolean — true if pharmacy pays mileage
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

// ─── Rate logic ───────────────────────────────────────────────────────────────

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

function verdict(offeredRate: number, avgItems: number, shiftType: string): string {
  const rec = recommendedRate(avgItems, shiftType);
  if (offeredRate >= rec + 1) return "Worth taking";
  if (offeredRate >= rec - 1) return "Fair rate";
  if (offeredRate >= rec - 3) return "Consider carefully";
  return "Below market rate";
}

function verdictReason(offeredRate: number, avgItems: number, shiftType: string): string {
  const rec = recommendedRate(avgItems, shiftType);
  const busy = avgItems > 8000 ? "busy" : avgItems > 4000 ? "moderate" : "quieter";
  const diff = offeredRate - rec;
  if (diff >= 1) return `${busy.charAt(0).toUpperCase() + busy.slice(1)} pharmacy paying above market for its workload.`;
  if (diff >= -1) return `Rate matches the expected range for a ${busy} pharmacy like this.`;
  if (diff >= -3) return `Rate is a little low for a ${busy} pharmacy (market ~£${rec}/hr). Negotiate if you can.`;
  return `Rate is well below market for this workload (~${avgItems > 1000 ? Math.round(avgItems / 100) * 100 : avgItems} items/month). Market rate here is ~£${rec}/hr.`;
}

// ─── Date/time helpers ────────────────────────────────────────────────────────

function fmtDate(d: string): string {
  const dt = new Date(d + "T12:00:00Z");
  return dt.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function hoursDecimal(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return (eh * 60 + em - (sh * 60 + sm)) / 60;
}

// ─── Sub-handlers ─────────────────────────────────────────────────────────────

async function handleShiftAnalysis(
  conversationId: string,
  userId: string,
  ext: ShiftExtraction
): Promise<string> {
  const searchQuery = [ext.pharmacy_name, ext.pharmacy_postcode ?? ext.pharmacy_address]
    .filter(Boolean)
    .join(" ");

  // Pharmacy search
  const pharmacyData = await botFetch<{ results?: Array<{ odsCode: string; name: string; address: string }> }>(
    `/pharmacy?q=${encodeURIComponent(searchQuery)}`
  );
  const match = pharmacyData.results?.[0];

  // Pharmacy history
  type HistoryMonth = { items: number; pharmacyFirstTotal: number; nms: number; bpChecks: number };
  type HistoryData = { months?: HistoryMonth[]; name?: string; address?: string };
  let history: HistoryData = {};
  if (match?.odsCode) {
    history = await botFetch<HistoryData>(`/pharmacy/history?ods=${match.odsCode}`);
  }

  // Compute averages over last 6 months
  const months = (history.months ?? []).slice(0, 6);
  const avg = (key: keyof HistoryMonth) =>
    months.length ? Math.round(months.reduce((s, m) => s + (m[key] ?? 0), 0) / months.length) : null;

  const avgItems = avg("items");
  const avgPF = avg("pharmacyFirstTotal");
  const avgNms = avg("nms");
  const avgBp = avg("bpChecks");

  // Distance
  type DistanceData = { oneway_miles?: number; return_miles?: number; duration_text?: string; error?: string };
  const pharmacyAddress = match?.address ?? ext.pharmacy_address ?? ext.pharmacy_postcode ?? ext.pharmacy_name ?? "";
  const distData = await botFetch<DistanceData>(
    `/distance?auth_user_id=${encodeURIComponent(userId)}&to=${encodeURIComponent(pharmacyAddress)}`
  );

  // Hours & pay
  const hours = hoursDecimal(ext.start_time!, ext.end_time!);
  const shiftType = ext.shift_type ?? "standard";

  // Rate — use given rate or recommend based on workload
  const rateProvided = ext.hourly_rate != null;
  const rate = ext.hourly_rate ?? recommendedRate(avgItems ?? 3000, shiftType);
  const totalPay = (rate * hours).toFixed(0);

  // Store pending shift
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
  states.set(conversationId, { phase: "awaiting_confirmation", pending });

  // Build response
  const lines: string[] = [];

  lines.push("SHIFT SUMMARY");
  lines.push(`Pharmacy: ${match?.name ?? ext.pharmacy_name ?? "Unknown"} (${match?.odsCode ?? "ODS not found"})`);
  if (match?.address) lines.push(`Address: ${match.address}`);
  lines.push(`Date: ${fmtDate(ext.shift_date!)} | ${ext.start_time}–${ext.end_time} (${hours % 1 === 0 ? hours : hours.toFixed(1)} hrs)`);

  if (!rateProvided) {
    lines.push(`Rate: No rate offered — suggested rate: £${rate}/hr = £${totalPay} for the day`);
  } else {
    lines.push(`Rate: £${rate}/hr = £${totalPay} for the day`);
  }

  if (!distData.error && distData.oneway_miles != null) {
    lines.push(`Distance: ${distData.oneway_miles} mi one-way (${distData.return_miles} mi return) — ${distData.duration_text ?? "?"} drive`);
  } else if (distData.error === "no_postcode") {
    lines.push("Distance: Add your home postcode in account settings to get driving distance.");
  }

  lines.push("");

  if (avgItems != null) {
    lines.push("WORKLOAD (avg last 6 months):");
    lines.push(`Items: ~${avgItems.toLocaleString()}/month`);
    lines.push(`Pharmacy First: ~${(avgPF ?? 0).toLocaleString()}/month`);
    lines.push(`NMS: ~${(avgNms ?? 0).toLocaleString()}/month`);
    lines.push(`BP Checks: ~${(avgBp ?? 0).toLocaleString()}/month`);
  } else {
    lines.push("WORKLOAD: No Data1st data available for this pharmacy.");
  }

  lines.push("");

  if (rateProvided && avgItems != null) {
    const v = verdict(rate, avgItems, shiftType);
    const reason = verdictReason(rate, avgItems, shiftType);
    lines.push(`VERDICT: ${v}`);
    lines.push(reason);
  } else if (!rateProvided && avgItems != null) {
    const rec = recommendedRate(avgItems, shiftType);
    lines.push(`RATE SUGGESTION: £${rec}/hr`);
    lines.push(`Based on ${avgItems.toLocaleString()} items/month avg. Counter at or above this rate.`);
  } else if (rateProvided) {
    const rec = recommendedRate(3000, shiftType);
    const v = verdict(rate, 3000, shiftType);
    lines.push(`VERDICT: ${v} (no workload data — based on rate alone)`);
    lines.push(`Market rate for a standard pharmacy is around £${rec}/hr.`);
  }

  lines.push("");

  if (ext.mileage_paid && ext.mileage_pence_per_mile) {
    const threshold = ext.mileage_threshold_miles ? ` after ${ext.mileage_threshold_miles} miles` : "";
    lines.push(`Mileage: ${ext.mileage_pence_per_mile}p/mile${threshold} (pharmacy pays)`);
  } else {
    lines.push("Mileage: HMRC 45p/mile (no reimbursement mentioned)");
  }

  lines.push("");
  lines.push("Reply YES to log this shift, or NO to decline.");

  return lines.join("\n");
}

async function handleSaveShift(conversationId: string, userId: string, pending: PendingShift): Promise<string> {
  const result = await botFetch<{
    ok?: boolean;
    shift_id?: string;
    mileage_miles?: number | null;
    mileage_manual_needed?: boolean;
    error?: string;
  }>("/save-shift", {
    method: "POST",
    body: JSON.stringify({ auth_user_id: userId, pending_shift: pending }),
  });

  states.set(conversationId, { phase: "idle" });

  if (result.error === "no_pending_shift") {
    return "Session expired. Please send the shift message again.";
  }
  if (!result.ok) {
    return "Failed to log the shift. Please try again or add it manually at locum1st.y-hs.net/shifts";
  }

  const lines = [
    "Shift logged!",
    "",
    pending.pharmacy_name,
    `${fmtDate(pending.shift_date)}, ${pending.start_time}–${pending.end_time}`,
    `£${pending.hourly_rate}/hr`,
  ];

  if (result.mileage_miles) {
    lines.push("", `Mileage: ${result.mileage_miles} mi auto-logged (HMRC 45p/mi).`);
  } else if (result.mileage_manual_needed) {
    lines.push("", "Add mileage manually at locum1st.y-hs.net/mileage");
  }

  lines.push("", "View at locum1st.y-hs.net/shifts");
  return lines.join("\n");
}

async function handleListShiftsForDelete(conversationId: string, userId: string): Promise<string> {
  const data = await botFetch<{ shifts?: Shift[]; error?: string }>(
    `/shifts?auth_user_id=${encodeURIComponent(userId)}&upcoming=true`
  );

  if (!data.shifts?.length) {
    return "You have no upcoming shifts logged.";
  }

  states.set(conversationId, { phase: "awaiting_delete", shifts: data.shifts });

  const list = data.shifts
    .map((s, i) => `${i + 1}. ${s.pharmacy_name} — ${fmtDate(s.shift_date)}, ${s.start_time}–${s.end_time}`)
    .join("\n");

  return `Which shift do you want to cancel?\n\n${list}\n\nReply with the number.`;
}

async function handleDeleteShift(conversationId: string, userId: string, shift: Shift): Promise<string> {
  const result = await botFetch<{ ok?: boolean; error?: string }>("/delete-shift", {
    method: "POST",
    body: JSON.stringify({ auth_user_id: userId, shift_id: shift.id }),
  });

  states.set(conversationId, { phase: "idle" });

  if (!result.ok) {
    return "Failed to delete that shift. Try again or remove it manually at locum1st.y-hs.net/shifts";
  }

  return [
    "Shift deleted.",
    "",
    shift.pharmacy_name,
    `${fmtDate(shift.shift_date)}, ${shift.start_time}–${shift.end_time}`,
    "",
    "(The linked mileage log has been kept — remove it manually at locum1st.y-hs.net/mileage if needed.)",
  ].join("\n");
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function processMessage(
  conversationId: string,
  userId: string,
  text: string
): Promise<string> {
  const state = states.get(conversationId) ?? { phase: "idle" };
  const trimmed = text.trim();

  // ── State: awaiting YES/NO confirmation ──────────────────────────────────
  if (state.phase === "awaiting_confirmation") {
    if (/^(yes|y|confirm|log|accept|ok|sure|yep|yeah)\b/i.test(trimmed)) {
      return handleSaveShift(conversationId, userId, state.pending);
    }
    if (/^(no|n|decline|skip|nope|cancel|pass)\b/i.test(trimmed)) {
      states.set(conversationId, { phase: "idle" });
      return "Shift declined. Send another shift offer whenever you're ready.";
    }
    // Not a yes/no — fall through to re-analyse (maybe they sent a new shift)
    states.set(conversationId, { phase: "idle" });
  }

  // ── State: awaiting delete selection ────────────────────────────────────
  if (state.phase === "awaiting_delete") {
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= state.shifts.length) {
      return handleDeleteShift(conversationId, userId, state.shifts[num - 1]);
    }
    if (/^\d+$/.test(trimmed)) {
      return `That number isn't in the list. Reply with a number from 1 to ${state.shifts.length}.`;
    }
    // Not a number — fall through to handle as new intent
    states.set(conversationId, { phase: "idle" });
  }

  // ── Pro check ────────────────────────────────────────────────────────────
  const userStatus = await botFetch<{ linked?: boolean; pro?: boolean; name?: string }>(
    `/user?auth_user_id=${encodeURIComponent(userId)}`
  );

  if (!userStatus?.linked || !userStatus?.pro) {
    return "Shift analysis is a Locum1st Pro feature. Upgrade to Pro at locum1st.y-hs.net/upgrade to use the bot.";
  }

  // ── Cancel / delete shift ─────────────────────────────────────────────────
  // Catches: "cancel my shift", "my shift was cancelled", "delete a shift",
  //          "shift got cancelled", "remove shift", "cancel the Boots shift"
  if (
    /\b(cancel|cancelled|cancelling|delete|deleted|remove|removed)\b/i.test(trimmed) &&
    /\bshift\b/i.test(trimmed)
  ) {
    return handleListShiftsForDelete(conversationId, userId);
  }

  // ── Show shifts ───────────────────────────────────────────────────────────
  if (/\b(show|list|my)\b.*\bshift(s)?\b/i.test(trimmed)) {
    const data = await botFetch<{ shifts?: Shift[] }>(`/shifts?auth_user_id=${encodeURIComponent(userId)}`);
    if (!data.shifts?.length) return "You have no recent shifts logged.";
    return data.shifts
      .map((s, i) => `${i + 1}. ${s.pharmacy_name} — ${fmtDate(s.shift_date)}, ${s.start_time}–${s.end_time}, £${s.hourly_rate}/hr`)
      .join("\n");
  }

  // ── Greeting ──────────────────────────────────────────────────────────────
  if (/^(hi|hello|hey|help|what can you|what do you)\b/i.test(trimmed.toLowerCase()) && trimmed.length < 40) {
    return "Send me a shift offer and I'll analyse it — rate vs workload, driving distance, and whether the pay is fair — then log it to your profile if you want to accept it.";
  }

  // ── Extract shift offer ───────────────────────────────────────────────────
  const ext = await extractShift(text);

  if (!ext.is_shift_offer) {
    return "I'm here to analyse shifts and log them. Forward a shift offer to get started.";
  }

  // Check required fields
  const missing: string[] = [];
  if (!ext.pharmacy_name) missing.push("Pharmacy name");
  if (!ext.shift_date) missing.push("Date");
  if (!ext.start_time) missing.push("Start time");
  if (!ext.end_time) missing.push("End time");

  if (missing.length) {
    return `I need a bit more detail to analyse this shift. Please include:\n${missing.map(m => `- ${m}`).join("\n")}`;
  }

  console.log(`[${conversationId}] Analysing shift: ${ext.pharmacy_name} ${ext.shift_date} ${ext.start_time}-${ext.end_time}`);
  return handleShiftAnalysis(conversationId, userId, ext);
}
