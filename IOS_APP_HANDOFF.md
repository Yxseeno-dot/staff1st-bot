# Staff1st Bot → Locum1st iOS handoff

**Prepared:** 18 August 2026

**Bot changes reviewed:** 6–8 August 2026 (`743cbdb` through `00aa1b4`)

**iOS project reviewed:** `Locum1st/ios-app`

## Executive summary

The bot's recent work improves how forwarded shift messages are interpreted and saved. Most changes do **not** introduce new fields in the public shift API: they produce better values in fields the iOS app already reads.

One new message metadata action was introduced: `select_pharmacy`. The iOS AutoFill flow already supports it as of Locum1st commit `6b18f80` (8 August 2026). That integration should be retained and regression-tested.

The remaining iOS work is primarily to verify that bot-created shifts are presented consistently, especially for past shifts, map addresses, computed ASAP start times, role-specific rate guidance, and travel compensation.

## Integration status

| Bot change | iOS impact | Status / action |
|---|---|---|
| Ambiguous pharmacy selection | New message metadata action and candidate list | **Already implemented** in AutoFill; regression-test it |
| Single pharmacy search result is auto-accepted | The selection UI is no longer shown for a single result | No code change; update tests that expect a confirmation prompt |
| Missing/unmappable pharmacy asks for a postcode | Bot sends a normal text prompt and consumes the typed reply | No special UI required; verify free-text replies remain enabled |
| Multi-pharmacy and multi-date offers | One analysis can produce a combined `select_dates` list | Existing UI supports date options; test mixed pharmacy/date labels and multi-select replies |
| Retrospective shift logging and corrected year handling | Bot can intentionally create past shifts | Ensure newly saved past shifts refresh into history rather than appearing as upcoming |
| Address normalization | Saved fallback addresses now end with a UK postcode | Existing `applyParsedAddress` should benefit; regression-test map pins and edit forms |
| ASAP start calculation | Bot saves a concrete `start_time`, calculated from travel duration and rounded up | No new model field; display the saved time normally and refresh after logging |
| Negotiable/TBC rate | Bot asks for the agreed hourly rate before analysis | No special UI required; numeric/free-text replies must remain available |
| Role-aware benchmarks | Suggested rates and verdicts use the user's verified role | No schema change; verify role shown in bot summary agrees with the account role |
| Full mileage (`FM`) | Bot assumes 55p/mile when no rate is supplied and clearly labels the assumption | Existing mileage fields are used; verify the app displays the saved reimbursement values |
| Paid travel hours | Bot converts hours into `travel_allowance_fixed` using the shift rate as an explicit assumption | No new API field; iOS will see a fixed travel allowance |
| Open-ended recurring availability | Bot does not invent shift rows; it reports the pattern in chat only | No calendar/model change required |

## Message metadata contract

### Pharmacy selection

When several pharmacy records are plausible, the bot returns:

```json
{
  "action": "select_pharmacy",
  "candidates": [
    {
      "name": "Example Pharmacy",
      "address": "1 High Street, Leeds, LS1 1AA"
    }
  ]
}
```

The iOS client should:

- Render each candidate as a tappable choice, including its address.
- Send the candidate's 1-based number as the reply (`"1"`, `"2"`, etc.).
- Include a **None of these** option that sends `"none"`.
- Show these controls only on the latest actionable bot message.
- Preserve ordinary text entry because the next bot step may request a postcode or rate.

This behavior is present in `Features/Auth/AutoFillView.swift` in iOS commit `6b18f80`.

Important behavioral update from bot commit `00aa1b4`: a search returning exactly one pharmacy is now accepted automatically. `select_pharmacy` will normally be emitted only when multiple results remain ambiguous. iOS tests must not require the action for a single result.

### Existing date selection, now used more broadly

Multi-date and multi-pharmacy broadcasts use the existing shape:

```json
{
  "action": "select_dates",
  "dates": [
    "Mon, 24 Aug – Pharmacy A",
    "Wed, 26 Aug – Pharmacy B"
  ]
}
```

Despite the field name `dates`, labels may now contain both a date and pharmacy name. The UI should treat each value as an opaque display label. Replies remain `"1"`, `"1,3"`, `"all"`, or `"none"`.

## Shift data behavior the iOS app must reflect

No new shift response property is required for these changes. The bot continues saving values into the existing shift fields.

### Dates and list placement

- Past shifts can now be logged deliberately from messages such as “I worked Tuesday”.
- An explicitly supplied year is preserved even when the date is in the past.
- Bare dates use a three-month recent-past grace window; older offer dates may roll into the next year.
- Related dates in one rota remain in the same year rather than being split inconsistently.
- “Today” is resolved using `Europe/London`, not the server's UTC calendar day.

iOS acceptance requirement: after the save response, refresh shifts and place each row according to its returned `shiftDate`. Do not assume a bot-created shift is upcoming.

### Pharmacy addresses and maps

Fallback addresses now have the known postcode appended as a final comma-separated segment, for example:

```text
12 High Street, Ashbourne, DE6 1AA
```

This deliberately matches the iOS `applyParsedAddress` behavior and improves geocoding. Test that bot-created shifts:

- Populate the postcode in the edit form.
- Show a map pin when a usable postcode was supplied.
- Continue to render safely if the user chose to skip the postcode prompt.

### ASAP shifts

For a same-day “ASAP” offer, the bot calculates an arrival time from the user's route duration and rounds it up to the next half hour. For a future-dated ASAP message, it uses `09:00`. The saved record contains an ordinary concrete `startTime`; the iOS model does not need an `isASAP` field.

### Rates and roles

Market-rate suggestions now use `profiles.role_type` and normalize `pharmacist` to `locum_pharmacist`. Supported pricing roles include locum pharmacist, pharmacy technician, ACT, and dispenser.

When a message explicitly says the rate is negotiable/TBC but gives no number, the bot asks for the actual agreed rate before saving. A merely omitted rate is different: the bot presents a market-rate suggestion.

iOS should keep the role displayed in the bot's markdown summary and the account's verified role visually coherent. No new decoding work is required.

### Travel and mileage

- `FM` / “full mileage” is saved through the existing mileage properties. If no pence rate was stated, the bot assumes 55p/mile and says that this is an assumption.
- “2 hours travel paid” is not mileage. The bot estimates its value at the shift hourly rate and saves the result into existing `travelAllowanceFixed`.
- Fixed cash travel allowances continue to use `travelAllowanceFixed`.

The current API cannot distinguish an originally stated fixed cash allowance from a bot-calculated paid-travel-hours allowance after saving. If the product needs to preserve that distinction in shift details or invoices, add explicit server/API fields such as `travelHoursPaid` and `travelHourlyRate` before extending the Swift models. Do not infer the distinction in iOS from the amount.

## Recommended iOS acceptance tests

1. **Ambiguous pharmacy:** two candidates render as buttons; selecting the second sends `"2"`; None sends `"none"`.
2. **Single pharmacy result:** the bot proceeds directly to analysis without showing pharmacy choices.
3. **Unknown pharmacy:** the text composer accepts a postcode and the saved shift maps correctly.
4. **Unknown pharmacy, skipped:** sending `"skip"` still allows the flow to continue without crashing map/edit views.
5. **Multi-branch broadcast:** option labels show the correct pharmacy next to each date; selecting several logs all selected shifts.
6. **Historical shift:** a shift logged for a past date appears in history, not upcoming.
7. **ASAP shift:** the concrete calculated start time in the saved shift matches the confirmation summary.
8. **Technician/ACT/dispenser account:** the bot summary shows the correct role and a role-appropriate rate, and the saved shift decodes normally.
9. **Full mileage:** mileage-paid state and 55p/mile assumption appear correctly after refresh.
10. **Paid travel hours:** the resulting fixed travel allowance appears in shift details and totals without being labelled as per-mile reimbursement.
11. **Postcode parsing:** an unmatched pharmacy address ending in a postcode populates the postcode field and map pin.
12. **Open-ended recurrence:** chat reports the recurring pattern but no fabricated future shifts appear in the shift list.

## Release checklist

- Keep iOS commit `6b18f80` or equivalent `select_pharmacy` support in the release branch.
- Run the acceptance cases above against the deployed bot and API, not mocked message text alone.
- Confirm a completed bot action triggers the same shift-store refresh as manual shift creation.
- Confirm both AutoFill/onboarding chat and any full Messages surface decode unknown metadata safely.
- No Swift API model additions are required for the current bot payloads.

## Source commits reviewed

- `743cbdb` — price shifts using the locum's role
- `1f52d28` — avoid truncated multi-date extraction and invented recurrence
- `886d52c`, `a610929`, `3610c2c` — coherent bare-date and year handling
- `b009413` — distinguish paid travel hours from mileage/cash allowance
- `d2331a7`, `00aa1b4` — pharmacy matching and single-result behavior
- `2766b77` — calculated ASAP start and full-mileage handling
- `8aa73fd` — historical shifts and postcode-normalized addresses
- `2b1aa9d` — postcode prompt for unmappable shifts
- `4bc1fb3` — agreed-rate prompt for negotiable shifts
- Locum1st iOS `6b18f80` — pharmacy-selection UI integration
