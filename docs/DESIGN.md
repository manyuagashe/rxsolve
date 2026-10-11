# RxSolve: Technical Design

*Rx + resolve.* A payments processor for pharmacies that guarantees every prescription claim resolves at or above acquisition cost, recovering in-flight and automatically, with no human filing anything.

HackNC, MLH Sponsor Challenges, v1.3. October 10, 2026. 24-hour event, 12-hour build window, 3 people.

| Sponsor | Role |
|---|---|
| Photon Spectrum | Pharmacist channel (iMessage digest and exceptions); WhatsApp/SMS to wholesaler |
| Capital One Nessie | Ledger: remittance deposits and fee transfers |
| TigerData | Database: every collection on Postgres; append-only logs as TimescaleDB hypertables; a continuous aggregate drives the dashboard's recovered-over-time chart |
| ElevenLabs (stretch) | Voice recap in the digest; phone negotiation with the PBM. Both are stretch goals, built only after the core demo path is green |
| Frutiger Aero track | Two DORFic Frutiger Aero skins on the dashboard (daylight "Frutiger Aero" and "Dark Aero"), switched live |

Related docs: [BUILD_PLAN.md](BUILD_PLAN.md), [TICKETS.md](TICKETS.md), [DEMO.md](DEMO.md), [DECISIONS.md](DECISIONS.md), [STATUS.md](STATUS.md).

> **Code samples in this doc are Python-flavored pseudocode.** The implementation is TypeScript on Bun; each section names the file that implements it. Repo layout and owners: [README](../README.md).

## 1. Overview and the Problem

### 1.1 The problem, concretely

When a patient fills a prescription, the claim adjudicates through the pharmacy benefit manager's (PBM) switch and the pharmacy is reimbursed a contracted rate. For generic drugs, that rate is capped by a MAC list, a maximum allowable cost schedule maintained by the PBM and updated at its discretion.

When that cap sits below the pharmacy's wholesale acquisition cost, the pharmacy dispenses the drug anyway, because the patient needs it, and eats the loss. The arithmetic is brutal and completely invisible:

| One pharmacy, generic-heavy book | |
|---|---|
| Generic claims filled per day | 200 |
| Average shortfall per claim | $2.00 |
| Annual unrecovered revenue | $146,000 |
| Claims legally appealable (35+ states) | 100% |
| Claims actually appealed today | ~0% |

Nobody appeals because each claim is worth $5 and takes twenty minutes of manual work to assemble, file, and chase. Worse, every PBM wants the appeal through a different door: a web portal, an email inbox, a fax number, a phone call. The money is owed by rule and uncollected by arithmetic.

### 1.2 What RxSolve is

Not a reporting dashboard. Not a document-scanning service. Not a back-office analytics tool.

A payments processor whose product surface is a single guarantee: **the claim resolved at or above cost.**

The pharmacy changes nothing about how it operates: no new portal, no new login, no new report. The recovery runs in the background of transactions the pharmacy already processes. The pharmacist hears from RxSolve once a day.

### 1.3 Core thesis

> The claim is checked at the point of sale, the underpayment is proven with the pharmacy's own invoice, the appeal is filed through whichever channel that PBM actually accepts, and the recovery is settled in real accounts.

The product is channel-agnostic: one detection and evidence core, one adapter per PBM door.

## 2. Scope

### 2.1 In

- A pharmacy management system (PMS) mock whose cashier terminal emits NCPDP-shaped claims and displays NCPDP-shaped responses
- Real-time underpayment detection at point of sale (NADAC + acquisition cost + contract rate)
- Statutory citation generation with per-state appeal windows
- Evidence PDF assembly from the wholesaler invoice line
- Three PBM channels, each against its own mock: web portal (browser agent), email, fax
- Deterministic concession logic per PBM, with live denial handling
- Pharmacist iMessage digest, exception pings, and a standing authorization policy
- Wholesaler document requests over WhatsApp/SMS
- Deadline clock with state-regulator escalation path
- Nessie settlement: PBM remittance deposit plus contingency fee transfer, backed by an 835-style remittance record
- RxSolve dashboard with a Frutiger Aero / Dark Aero theme switcher, plus the separate PMS mock at `/pms`
- 60-claim seeded history (~18 underwater), spread across the three PBM personas
- Abandonment logging with reasons, reported honestly

### 2.2 Stretch

- ElevenLabs voice recap inside the digest
- Phone: the agent calls the PBM and negotiates a disputed denial (ElevenLabs STT/TTS loop)

### 2.3 Out (and it stays out)

- Real PBM portals or real payer integrations; the PBMs are mocks modeled on public procedures
- Real fax transport (see 13)
- NCPDP wire-format fidelity or certification; messages are JSON with the real field names
- Real NADAC API (seeded fixture only)
- Multi-pharmacy or multi-state rollout beyond the demo
- Any real PHI (synthetic patient references only)
- ElevenLabs hosted Conversational AI (we self-implement the loop)
- Auth, multi-tenancy, production hardening

> **The T+10 Rule.** Anything not visible in a four-minute demo gets cut at T+10. Features yield to the demo path, never the reverse.

## 3. System Components

| Component | Owner | Responsibility |
|---|---|---|
| Orchestrator | P1 | Central coordinator. Performs no recovery action itself. Gates every transition: Watcher first; Evidence Builder only on UNDERWATER; Filing only on complete evidence; Negotiation only on a denial. |
| Adjudication Watcher | P2 | Runs on every claim at point of sale. Compares paid against acquisition cost, NADAC, and contract rate. Emits CLEAR, MARGINAL, or UNDERWATER with a delta. |
| Evidence Builder | P2 | Runs only on UNDERWATER. Retrieves the state statute, assembles the invoice PDF, scores completeness against the target PBM's required-field list. |
| Filing & Negotiation | P2 | **Filing** (deterministic): pick the PBM's channel adapter, fill its spec, submit. **Negotiation** (agentic): on denial, diagnose and choose remediate, escalate, or abandon. |
| Channel Adapters | P2 | One per PBM door: `PortalAdapter` (browser agent), `EmailAdapter`, `FaxAdapter`, `PhoneAdapter` (stretch). Common interface (see 7.3). |
| Pharmacist Notifier | P2 | Builds the daily digest and exception pings; reads replies. Spectrum iMessage. Voice recap via ElevenLabs (stretch). |
| Wholesaler Contact | P2 | WhatsApp/SMS document requests for missing attestations and invoices. |
| PBM Sim | P1 | Standalone service. One deterministic decision engine behind three front doors (portal, email inbox, fax line) plus a phone rep (stretch). Three personas modeled on public PBM appeal procedures. |
| Nessie Ledger | P1 | Pharmacy, PBM, platform, and patient accounts as real ledger entities. |
| PMS Mock | P3 | The pharmacy's own dispensing system, a separate app at `/pms` with its own look (no theme switcher, no RxSolve state). Emits NCPDP-shaped B1 claims to the PBM Sim switch and shows the payer's response or rejection. RxSolve never links to it. |
| Dashboard | P3 | Recovery feed, pipeline board, ledger panel, channel viewer. |

## 4. Architecture

```
PMS Mock / Cashier (P3)       NCPDP-shaped B1 claim
        |
        v
PBM Sim switch  <-- claim feed --  Orchestrator (P1)   gates transitions
 (adjudicates)                         |
                                       +--> Adjudication Watcher (P2)    deterministic
                                       +--> Evidence Builder (P2)        fully agentic
                                       +--> Filing & Negotiation (P2)
                                       |        |
                                       |        +--> PortalAdapter  --> PBM Sim portal   (web form)
                                       |        +--> EmailAdapter   --> PBM Sim inbox    (email + PDF)
                                       |        +--> FaxAdapter     --> PBM Sim fax line (PDF in, scan out)
                                       |        +--> PhoneAdapter   --> PBM Sim rep      (stretch)
                                       |        +--> Wholesaler Contact (WhatsApp/SMS)
                                       v
                          Pharmacist Notifier (P2)
                          iMessage: daily digest, exceptions, replies

Deadline Clock (P1)    state windows
Nessie Ledger (P1)     remittance deposit + 25% fee
Dashboard (P3)         WebSocket live feed
```

PBM Sim shares no code or database with the agents. The agents reach it only over HTTP, email, fax, or audio, exactly as they would reach a real PBM.

## 5. Core Flows

### 5.1 Happy path with remediation (the demo path)

```
PMS submits B1 -> PBM Sim switch pays -> Watcher flags -> Evidence Builder -> Adapter files
(NCPDP-shaped)  paid = $6.40         UNDERWATER       (invoice+statute)   via PBM's channel
      |
      v
PBM Sim denies -> Negotiation -> Wholesaler   -> Adapter refiles -> PBM Sim approves
(missing field)   diagnoses      WhatsApp reply   same channel       remittance posted
      |
      v
Nessie deposit + fee -> Digest to pharmacist (-> voice recap, stretch)
```

1. PMS mock submits an NCPDP-shaped B1 claim (NDC, quantity, days supply, date of service, submitted cost)
2. PBM Sim switch returns a paid response: total amount paid $6.40 against acquisition cost $12.80
3. Watcher: UNDERWATER, delta = $6.40, deadline = TN, 7 business days
4. Evidence Builder assembles the appeal PDF plus citation block
5. Filing selects the adapter for the claim's PBM and submits (portal form, email, or fax)
6. PBM Sim denies after its response delay: wholesaler attestation missing (TN rule)
7. Negotiation diagnoses the missing field, requests it from the wholesaler over WhatsApp, receives it, refiles through the same channel
8. PBM Sim approves; remittance adjustment posts
9. Ledger: deposit PBM to pharmacy $6.40; fee pharmacy to platform $1.60
10. Digest to pharmacist reports the recovery (stretch: a voice recap plays in-thread)
11. Dashboard updates live; deadline clock satisfied

### 5.2 End-to-end data flow

| Stage | Data contract |
|---|---|
| Human input | Seeded claim set in the `claims` table; live claims from the PMS mock cashier terminal |
| Watcher | claim to `{paid, acquisition_cost, nadac, contract_rate}` to verdict |
| Evidence | verdict + state + PBM spec to citation + invoice PDF + completeness |
| Filing | evidence + PBM spec to channel adapter to `ticket` |
| Negotiation | denial to diagnose to remediate (WhatsApp/SMS) to refile |
| Ledger | APPROVED to 835-style remittance record, Nessie deposit, and 25% contingency fee |
| Notifier | state transitions to daily digest, exception pings |
| Dashboard | WebSocket stream of all state transitions and ledger balances |

### 5.3 Data contracts

These shapes live in code in `packages/contracts/src/index.ts` (zod schemas plus inferred types). The API and the dashboard import them; the PBM Sim does not. Dates are `YYYY-MM-DD` strings and timestamps ISO 8601 UTC.

**Claim**

The NCPDP-shaped request and response are carried verbatim under `ncpdp`; the flat fields are derived for the agents. Field IDs and names were verified in RES-01 against the CMS Medicare Part D NCPDP D.0 payer sheet for the GLP-1 Bridge (dated 2026-03-16, https://www.cms.gov/files/document/glp-1-bridge-payer-sheet.pdf):

| Field ID | NCPDP name | Direction |
|---|---|---|
| `401-D1` | Date of Service | request |
| `402-D2` | Prescription/Service Reference Number | request |
| `407-D7` | Product/Service ID (11-digit NDC, qualifier `436-E1` = 03) | request |
| `442-E7` | Quantity Dispensed | request |
| `405-D5` | Days Supply | request |
| `409-D9` | Ingredient Cost Submitted | request |
| `426-DQ` | Usual and Customary Charge | request |
| `112-AN` | Transaction Response Status (`P` paid, `R` rejected) | response |
| `506-F6` | Ingredient Cost Paid | response |
| `505-F5` | Patient Pay Amount | response |
| `509-F9` | Total Amount Paid | response |
| `511-FB` | Reject Code (count in `510-FA`) | response |

All twelve IDs in the example match the payer sheet. The header response status is a separate field, `501-F1`, so `112-AN` is the per-transaction status.

```json
{
  "claim_id": "RXS-0001",
  "pharmacy_id": "PH-MEADOWBROOK",
  "pbm": "PBM_PORTAL",
  "state": "TN",
  "plan": "TN Part D",
  "patient_ref": "PT-7F3A",
  "ndc": "00378001801",
  "qty": 1000,
  "fill_date": "2026-03-14",
  "paid_amount": 6.40,
  "acquisition_cost": 12.80,
  "nadac": 11.95,
  "contract_rate": 7.10,
  "ncpdp": {
    "transaction": "B1",
    "request": {
      "401-D1": "20260314",
      "402-D2": "1048213",
      "407-D7": "00378001801",
      "442-E7": 1000,
      "405-D5": 30,
      "409-D9": 14.50,
      "426-DQ": 18.00
    },
    "response": {
      "112-AN": "P",
      "506-F6": 6.40,
      "505-F5": 0.00,
      "509-F9": 6.40,
      "511-FB": null
    }
  }
}
```

| Derived field | Source |
|---|---|
| `ndc` | `407-D7` |
| `qty` | `442-E7` |
| `fill_date` | `401-D1` |
| `paid_amount` | `509-F9` (total amount paid) |

`acquisition_cost`, `nadac`, and `contract_rate` come from the invoice store, the NADAC fixture, and the contract table, never from the claim message.

**Watcher verdict**

```json
{
  "claim_id": "RXS-0001",
  "verdict": "UNDERWATER",
  "delta": 6.40,
  "benchmark_used": "acquisition_cost",
  "appeal_deadline": "2026-03-23",
  "confidence": 0.97,
  "reason": "underpaid"
}
```

`reason` is one of `no_invoice`, `paid_at_or_above_cost`, `marginal_resolved_clear`, `marginal_resolved_underwater`, `marginal_unresolved`, `underpaid`. It is optional on parse so verdicts stored before it existed still load.

**Evidence packet**

```json
{
  "claim_id": "RXS-0001",
  "statute": "Tenn. Code Ann. 56-7-3206(c)(2)(B)(ii)",
  "entitlement": "PBM shall reimburse at actual acquisition cost when MAC falls below cost",
  "attachments": ["wholesaler_invoice_RXS-0001.pdf"],
  "required_fields_present": ["ndc", "invoice_date", "acquisition_cost", "wholesaler_attestation"],
  "spec_version": "pbm_portal@2026-10-10",
  "completeness": 0.75,
  "fields": { "ndc": "00378001801", "invoice_number": "INV-55120", "...": "..." },
  "delta": 6.40,
  "appeal_deadline": "2026-03-23"
}
```

`fields` (the values an adapter puts on the PBM's form), `delta` and `appeal_deadline` are additions to the original example. Completeness is scored against *our* spec of the PBM; the orchestrator files only at 1.0. A PBM can still deny for a field our spec did not know it required (the TN attestation in the demo), which is what negotiation remediates.

**Appeal ticket (returned by every adapter)**

```json
{
  "claim_id": "RXS-0001",
  "pbm": "PBM_PORTAL",
  "channel": "portal",
  "ticket_id": "PRT-48213",
  "submitted_at": "2026-03-14T15:02:11Z",
  "expected_response_by": "2026-03-14T15:04:00Z"
}
```

**Ledger settlement**

```json
{
  "event": "RECOVERY_SETTLED",
  "claim_id": "RXS-0001",
  "transfers": [
    { "from": "PBM-PORTAL", "to": "PH-MEADOWBROOK", "amount": 6.40, "kind": "remittance_adjustment" },
    { "from": "PH-MEADOWBROOK", "to": "RXSOLVE-PLATFORM", "amount": 1.60, "kind": "contingency_fee" }
  ]
}
```

### 5.4 Standards alignment

| Real-world standard | Where it appears | Fidelity |
|---|---|---|
| NCPDP Telecommunication D.0 (B1 bill, B2 reverse, B3 rebill) | PMS mock to PBM Sim switch | JSON with real field IDs; not the delimited wire format |
| X12 835 electronic remittance advice | PBM adjustment record behind each Nessie deposit | 835-style record with the key fields |
| X12 810 invoice | Wholesaler invoice line in the seed and evidence PDF | 810-style line item |
| PBM payer sheets and MAC appeal procedures | `specs` collection, persona behavior | Cited from public documents in RES-01 |

Positioning: RxSolve sits beside the pharmacy's existing claim switch, reading adjudication responses and invoice feeds. The pharmacy changes nothing. In the demo, call the messages "NCPDP-shaped", never "NCPDP compliant".

**Remittance record (835-style)**

```json
{
  "remittance_id": "REM-0001",
  "type": "835-style",
  "payer": "PBM-PORTAL",
  "payee": "PH-MEADOWBROOK",
  "claim_id": "RXS-0001",
  "paid_original": 6.40,
  "adjustment": 6.40,
  "paid_total": 12.80,
  "reason": "MAC appeal approved",
  "posted_at": "2026-03-14T15:09:40Z"
}
```

The Nessie deposit references this record's `remittance_id` in its memo.

RES-01 checked the record against public X12 835 5010 material (CMS Medicare carrier 835 companion document, Dec 2004, https://www.cms.gov/files/document/partb835cdpdf; Indiana ISDH 835 5010 companion guide v3.0, Jan 2011, https://www.in.gov/health/cshcs/files/ISDH_Companion_Guide_835_5010.pdf). The record is 835-style, not an 835. The nearest real elements are:

| Our field | Nearest 835 element | Verified |
|---|---|---|
| `remittance_id` | `TRN02` check or EFT trace number | name confirmed (ISDH) |
| `paid_total`, `adjustment` | `BPR02` total actual provider payment amount (payment level); `CLP04` claim payment amount (claim level) | `BPR02` name confirmed; `CLP04` exists and is required (CMS), name not confirmed in a public sheet |
| `adjustment` as a claim correction | `CAS01` group code, `CAS02` reason code, `CAS03` amount (loop 2100, situational) | segment confirmed; element names not confirmed |
| recovery posted outside a claim | `PLB03` adjustment reason code and `PLB04` amount (provider-level adjustment) | elements exist (CMS); semantics not confirmed |

A real PBM reverses and rebills (B2 then B3) after an upheld MAC appeal, which produces a new claim payment rather than an "adjustment" field. The record keeps `adjustment` for dashboard clarity. The X12 835 implementation guide itself is paywalled and was not retrieved, so element semantics beyond the table are unverified.

**Live events (`ws://localhost:8000/ws/live`)**

Every message is `{ "type", "ts", "claim_id", "payload" }`. On connect the server replays recent history, then streams. `GET /api/events` returns the same history over HTTP.

| `type` | `payload` |
|---|---|
| `claim.received` | Claim plus `drug` (display name) |
| `claim.stage` | `{ stage, reason? }`; stage is one of CLEARED, DETECTED, EVIDENCE, FILED, NEGOTIATING, SETTLED, ESCALATED, ABANDONED, EXCEPTION |
| `verdict` | Watcher verdict |
| `evidence.built` | Evidence packet |
| `appeal.filed` | Appeal ticket |
| `appeal.decision` | `{ claim_id, ticket_id, status: APPROVED/DENIED, reason, field, delta, raw }` |
| `negotiation.action` | `{ kind: REFILED/ESCALATED/EXTERNAL_APPEAL/ABANDONED, ticket?, evidence?, reason? }` |
| `channel.message` | ChannelMessage on portal, email, fax, phone, whatsapp or sms (channel viewer) |
| `notifier.message` | ChannelMessage on imessage (pharmacist phone) |
| `ledger.settled` | Ledger settlement plus `remittance` |
| `ledger.balances` | `{ balances, recovered_to_date, fees_to_date }`, computed from ledger events |
| `exception.raised` | `{ reason, ask }` |

ChannelMessage: `{ claim_id, channel, direction: out/in, counterparty, text, attachments, audio_url, meta, ts }`. It is also the shape stored in `transcript`.

## 6. Agent Architecture

The split is deliberate: more agentic where reasoning or perception matters, deterministic where speed and reliability matter.

| Component | Autonomy model | Why |
|---|---|---|
| Orchestrator | Gates only | Sequencing and precondition checks must be exact. |
| Adjudication Watcher | Deterministic on the happy path | Three numbers, one comparison. MARGINAL verdicts escalate to the agent. |
| Evidence Builder | Fully agentic | Statute text is unstructured, jurisdiction-specific, and amended over time. |
| Filing | Deterministic per adapter | Each PBM spec has exact field names and formats. A wrong field is a rejected appeal. The portal adapter uses a browser agent but fills a fixed field map, with a scripted fallback. |
| Negotiation | Agentic | Reading a denial (portal message, email body, scanned fax reply), diagnosing, choosing remediate / escalate / abandon. |
| Notifier | Templated | Digest copy is templated with filled values; the model summarizes, never improvises. |
| Phone (stretch) | Agentic speech, deterministic outcome | The agent argues; the PBM rep's concede/deny is rule-based. |

> **Determinism Rule.** PBM Sim's decision is rule-based on evidence completeness and persona policy. No model decides whether a PBM concedes.
>
> A demo that hinges on a coin flip is a demo that dies on stage. A live denial followed by a deterministic win proves the loop handles failure.

## 7. The Agents

### 7.1 Adjudication Watcher

**Purpose.** Guarantee no claim resolves below cost without a verified recovery being opened.

```python
def adjudicate(claim, invoices) -> Verdict:
    acq = acquisition_cost(invoices, claim["ndc"], claim["fill_date"])
    delta = acq - claim["paid_amount"]     # the statutes entitle the pharmacy to acquisition cost
    if delta <= 0:
        return Verdict("CLEAR", delta=0.0)             # no model call on this path
    if delta <= MARGINAL_BAND_CENTS:
        return escalate_to_agent(claim, delta)         # judgment lives here
    return Verdict(
        "UNDERWATER",
        delta=delta,
        benchmark_used="acquisition_cost",
        appeal_deadline=deadline_for(claim["state"], claim["fill_date"]),
    )
```

NADAC and contract rate are carried on the claim for display and for the MARGINAL agent's judgment, not for the delta: `min(acq, nadac, contract)` would turn the demo claim's $6.40 underpayment into $0.70. Implemented in `apps/api/src/agents/watcher.ts`.

### 7.2 Evidence Builder

**Purpose.** Convert a dollar delta into a filing that survives review, shaped to the target PBM's spec.

```python
async def build_evidence(claim: Claim, verdict: Verdict) -> Evidence:
    statute = await retrieve_statute(claim["state"], topic="mac_appeal")
    entitlement = await extract_entitlement(statute, require="acquisition_cost_floor")
    pdf = render_invoice_line(invoice=claim.source_invoice, ndc=claim["ndc"], lot=claim["lot"])
    spec = PBM_SPECS[claim["pbm"]]                       # versioned, per-PBM
    present = check_present(claim, spec.required_fields)
    missing = [f for f in spec.required_fields if f not in present]
    return Evidence(
        claim_id=claim.claim_id,
        statute=statute.citation,
        entitlement=entitlement.text,
        attachments=[pdf],
        required_fields_present=present,
        spec_version=spec.version,
        completeness=1 - len(missing) / len(spec.required_fields),
        appeal_deadline=verdict.appeal_deadline,
    )
```

### 7.3 Filing, Channel Adapters, Negotiation

Every PBM door is wrapped in the same interface:

```python
class ChannelAdapter(Protocol):
    channel: str                                           # portal | email | fax | phone

    async def submit(self, claim: Claim, ev: Evidence) -> Ticket: ...
    async def poll(self, ticket: Ticket) -> Decision | None: ...   # None = still pending
    async def reply(self, ticket: Ticket, msg: Reply) -> Ticket: ...  # refile or rebut
```

| Adapter | Submit | Receive decision |
|---|---|---|
| Portal | Browser agent fills the PBM's form from a fixed field map, uploads the PDF | Reads the portal status page / message center |
| Email | Composes the appeal, attaches the PDF, sends to the PBM inbox | Parses the reply email against the PBM's reply template |
| Fax | Renders cover sheet + evidence PDF, sends to the fax line | Reads the returned scanned PDF with vision/OCR |
| Phone (stretch) | Calls the PBM rep, states the case | Hears the rep's decision in-call |

Filing always goes through `PBM_SPECS[claim.pbm].channel`; the Orchestrator never knows which door it is.

**Negotiation mode (agentic).** On denial, read the stated reason, classify it, and choose:

| Denial reason | Action |
|---|---|
| Missing required field | Remediate via WhatsApp/SMS to wholesaler, then refile through the same channel |
| Disputed but evidence complete | Escalate: rebut citing the statute; if the PBM persona has a phone rep, call (stretch); else request supervisor review |
| Appeal window expired | File external appeal with the state regulator |
| Claim not eligible | Abandon: log it, file nothing |

```python
async def on_denial(claim: Claim, denial: Denial) -> Action:
    ev = await load_evidence(claim.claim_id)
    adapter = adapter_for(claim.pbm)
    if denial.reason == "missing_field":
        doc = await wholesaler.request_document(
            channel="whatsapp", to=claim.wholesaler_contact, ask=denial.field_name
        )
        ev = await ev.with_document(doc)
        return Action("REFILED", await adapter.reply(denial.ticket, Reply(evidence=ev)))
    if denial.reason == "disputed" and ev.completeness == 1.0:
        return await escalate(claim, citation=ev.statute)
    if denial.reason == "window_expired":
        return await file_external_appeal(claim.claim_id, regulator=claim.state)
    return Action("ABANDONED", reason=denial.reason)
```

### 7.4 Pharmacist Notifier

**Purpose.** Keep the human who owns the pharmacy informed without becoming the work.

| Message | Trigger | Content |
|---|---|---|
| Daily digest | End of day (demo: manual trigger) | Found, filed, pending, recovered today and this week; one-word reply to act |
| Exception ping | Any of the exception triggers below | Single claim, one ask |
| On-demand reply | Pharmacist texts a question | Answer computed from the ledger |

**Standing authorization.** The pharmacist approves a policy once ("auto-file underpayments over $X with complete evidence"). Claims inside the policy never ask permission. Only claims outside it surface as exceptions.

**Exception triggers.** High-value claim; deadline at risk; claim abandoned; a document only the pharmacist can supply; regulator escalation.

```python
async def send_digest(pharmacy_id: str, day: date) -> None:
    s = await summarize_day(pharmacy_id, day)              # from ledger + db, not memory
    text = (
        f"RxSolve {day:%b %d}: found {s.found} underpaid claims (${s.found_amt}). "
        f"Filed {s.filed}, {s.pending} pending, recovered ${s.recovered}. "
        f"This week: ${s.week_recovered}. Reply DETAILS or PAUSE."
    )
    audio = await elevenlabs.tts(text, voice=PHARMACIST_VOICE)   # stretch (AGT-09); None when not configured
    await spectrum.send(channel="imessage", text=text, voice=audio)
```

### 7.5 Phone Negotiator (stretch)

The agent places a call to the PBM rep line and argues a disputed denial using the statute and the evidence packet. Loop: audio in, STT, reason, TTS. The rep persona may speak with scripted or model-voiced lines, but its concede/deny outcome is the deterministic rule from the PBM Sim engine.

Build order: simulated rep over WebSocket audio first; real telephony to a teammate's phone second; a pre-recorded call as the demo backup.

## 8. PBM Sim

A standalone FastAPI service with its own datastore. It exposes only what a real PBM exposes.

### 8.1 Personas

Three personas, each modeled on the public MAC appeal procedure of a major PBM (research ticket RES-01). Names on screen are lookalikes, never real logos or brand assets. Demo narration says "modeled on CVS Caremark, Express Scripts, and OptumRx".

| Persona | Modeled on | Demo channel (kept after RES-01) | Real public channels (RES-01) | Style |
|---|---|---|---|---|
| PBM_PORTAL | CVS Caremark | Web portal form | Pharmacy Portal MAC Appeals form only | Strict field names, immediate acknowledgement, decision in minutes (demo timing) |
| PBM_EMAIL | Express Scripts | Email with PDF | Pharmacist Resource Center portal Appeals tab; MAC department email listed as appeal contact; the Cigna form (Express Scripts network) accepts fax or email | Free-text intake, templated reply, denies on missing attachment |
| PBM_FAX | OptumRx | Fax with cover sheet | Pharmacy Portal spreadsheet only; email only for supporting invoices in AR and TN; no fax | Cover-sheet required fields, reply is a scanned PDF |

RES-01 outcome: the channel assignment is kept as a demo choice to show breadth. Portal matches CVS Caremark. Email is a real secondary door for Express Scripts. Fax is not a current OptumRx door; narration must say the persona uses OptumRx's field set and state rules, not that OptumRx takes fax. Specs per PBM are in `apps/api/src/fixtures/specs.json` with sources.

### 8.2 Front doors

| Door | Interface |
|---|---|
| Switch | `POST /switch/claim` accepts an NCPDP-shaped B1 (also B2 reversal, B3 rebill) and returns an NCPDP-shaped response with total amount paid and reject codes; used by the PMS mock |
| Portal | HTML form + status page, per-persona styling and field names |
| Inbox | Mailbox with HTTP API; inbound mail triggers a templated reply after a delay |
| Fax line | `POST /fax` accepts a PDF; the reply is rendered as a scanned-look PDF and queued on a return line |
| Rep line (stretch) | Audio WebSocket |
| Dev door | `POST /dev/appeals`, `GET /dev/appeals/:ticket`, `POST /dev/appeals/:ticket/reply`: JSON intake on the same engine, used by the API's `DirectAdapter` until the real doors land. Not shown in the demo. |

Switch request body: `{ "transaction": "B1", "meta": { claim_id?, pbm, pharmacy_id, state, plan, patient_ref }, "request": { NCPDP fields } }`. `meta` stands in for the routing a real claim gets from BIN/PCN. The switch stamps `401-D1` with today's date when it is absent. Every paid claim is teed to `CLAIM_FEED_URL` (the API's `POST /api/feed/claim`) as `{ meta, ncpdp }`, the way a switch vendor shares adjudication data with a pharmacy's service provider. Implemented in `apps/pbm-sim/src/`.

### 8.3 Decision engine

```python
def decide(spec: PBMSpec, evidence: Evidence) -> Decision:
    if spec.requires_all_fields and evidence.completeness >= 1.0:
        return Decision("APPROVED", delta=evidence.delta)
    if evidence.completeness >= spec.partial_threshold:
        return Decision("DENIED", reason="missing_field", field=first_missing(evidence, spec))
    return Decision("DENIED", reason="insufficient_evidence")
```

Each persona carries a seeded response delay, so the demo does not wait days. One persona is configured to deny first and approve on rebuttal, which is the phone-escalation path.

## 9. Orchestrator

```python
async def process_claim(claim_id: str) -> Outcome:
    claim = await db.claims.get(claim_id)

    acct = await nessie.get_account(claim.pharmacy_id)          # Gate 1: ledger reachable
    if acct is None:
        return await halt_and_flag(claim_id, "no_ledger_account")

    verdict = await adjudicate(claim)                            # Phase 1: no model on CLEAR
    await db.claims.update(claim_id, {"verdict": verdict})
    if verdict.verdict == "CLEAR":
        return Outcome("CLEARED", delta=0)

    evidence = await build_evidence(claim, verdict)              # Phase 2
    if not policy.allows(claim, evidence):                       # outside standing authorization
        return await notifier.raise_exception(claim, evidence)

    ticket = await file_appeal(claim, evidence)                  # Phase 3: PBM's channel adapter
    outcome = await await_resolution(ticket, timeout=claim.deadline)   # Phase 4: event-driven
    if outcome.status != "APPROVED":
        return outcome

    await settle_recovery(claim, outcome.delta, fee_pct=0.25)    # Phase 5
    return Outcome("RECOVERED", delta=outcome.delta)             # digest reports it


DEADLINES = {"TN": 7, "NC": 6, "GA": 10, "default": 20}   # business days; lower bound of the statutory calendar-day window (statutes.json)

def deadline_for(state, fill_date) -> date:
    return business_add(fill_date, DEADLINES.get(state, DEADLINES["default"]))
```

## 10. Data Layer

| Collection | Contents | Indexed |
|---|---|---|
| `claims` | Every adjudicated claim: paid vs. acquisition vs. NADAC vs. contract, verdict, state, PBM | `claim_id`, `{state, verdict}`, `fill_date` |
| `evidence` | Statute citation, entitlement, invoice PDF ref, completeness, required-field checklist, spec version | `claim_id`, `completeness` |
| `appeals` | Dispute lifecycle: channel, ticket, filing, denial reason, remediation, escalation, resolution | `claim_id`, `status`, `deadline` |
| `specs` | Per-PBM appeal specs: channel, required fields, formats, response SLA, source URL | `pbm`, `version` |
| `statutes` | Per-state entitlement text, appeal windows, regulator contact | `state` |
| `ledger_events` | Every Nessie movement | `claim_id`, `pharmacy_id` |
| `remittances` | 835-style remittance record per approved appeal | `claim_id`, `remittance_id` |
| `transcript` | Per claim, every message on every channel (portal receipts, emails, fax PDFs, wholesaler chat, iMessage) | `claim_id`, `ts` |
| `policy` | Pharmacist standing authorization | `pharmacy_id` |
| `audit` | Append-only log of agent spawns, gate decisions, state transitions | `claim_id`, `ts` |

Storage is TigerData (`apps/api/src/db.ts`): each collection is a Postgres table of jsonb documents (`key`, `ts`, `doc`) behind the same `Collection` interface as the in-memory double. `ledger_events`, `transcript` and `audit` are append-only and timestamped, so they are TimescaleDB hypertables on `ts`. The `recovery_series` continuous aggregate sums each settlement's recovered amount and fee per 15-second bucket (demo scale; production would use an hour) with real-time aggregation on, and backs `GET /api/ledger/series` (`RecoveryPoint[]`). On plain Postgres or in memory, the API buckets the same way itself.

**Safety property.** `statutes` and `specs` are versioned. Every appeal records the exact rulebook and spec version it was filed under, so a filed claim stays reproducible after a PBM changes its form.

## 11. Ledger

### 11.1 Capital One Nessie

Four entities, created at boot:

| Entity | Role |
|---|---|
| `PH-MEADOWBROOK` | Pharmacy business account; receives PBM remittance, pays fees |
| `PBM-*` | One per persona; funds remittance adjustments |
| `RXSOLVE-PLATFORM` | Collects the 25% contingency fee |
| `PATIENT-*` | Patient accounts for terminal-flow realism |

On Classic v1, logical actor IDs map to Checking-account nicknames under the synthetic `RxSolve Ledger2` customer. `NessieLedger` discovers existing customer/accounts before creating missing ones; each new account receives its own sandbox opening balance (`DEMO_OPENINGS`: pharmacy $48,250, platform $12,000, each PBM $2,000,000; the local double keeps $100,000 each). The dashboard shows only the pharmacy and platform accounts, since RxSolve cannot see a PBM's books. This opening balance is sandbox setup, not recovery revenue. Domain values stay in dollars; the adapter sends integer cents, and `transfer` posts a withdrawal then a deposit, both `status: "completed"` (a failed deposit throws a half-posted error and is not retried). The sandbox never updates an account's `balance` field, so `balances()` reports it as the opening balance plus completed deposits minus completed withdrawals. `settleRecovery` refuses a claim that already has a remittance before moving any money.

**Every displayed dollar is a real movement.** Remittance adjustment on approval, fee transfer on settlement. "Recovered to date" is a computed balance, not a stored counter.

```python
async def settle_recovery(claim: Claim, delta: Decimal, fee_pct: float = 0.25) -> None:
    await nessie.transfer(
        from_=claim.pbm_account, to_=claim.pharmacy_account, amount=delta,
        memo=f"remittance adjustment {claim.claim_id}",
    )
    await nessie.transfer(
        from_=claim.pharmacy_account, to_=PLATFORM_ACCOUNT,
        amount=round(delta * fee_pct, 2), memo=f"contingency fee {claim.claim_id}",
    )
    await db.remittances.insert_one(remittance_record(claim, delta))
    await db.ledger_events.insert_one(snapshot(claim, delta, fee_pct))
```

> **T+0 integration check: Nessie ships in two generations.**
>
> - **Classic:** `nessieisreal.com`, API key as a `?key=` query parameter, money moves via `POST /accounts/{id}/withdrawals` and `/deposits` (amounts in integer cents). Classic v1 documents no transfer create route.
> - **v2:** `/v2/accounts`, header-based authentication.
>
> Probe which one in the first ten minutes. If transfers are unavailable, fall back to bills for both movements.

## 12. Dashboard

| Panel | Contents |
|---|---|
| PMS Mock (`/pms`) | The pharmacy's dispensing screen: queue of prescriptions ready to bill, line items, the payer's NCPDP-shaped response or reject code. It shows nothing from RxSolve; recovery status lives on the RxSolve home claims list and status screen. |
| Live Recovery Feed | Cards as claims resolve: drug, delta, PBM, channel, deadline countdown, status |
| Pipeline Board | Kanban: DETECTED, EVIDENCE, FILED, NEGOTIATING, SETTLED, plus ESCALATED and ABANDONED. Deadline clock per card. |
| Ledger Panel | Nessie balances, recovered-to-date, fees accrued |
| Recovered Over Time | Cumulative recovered dollars as a step line, one point per time bucket, read from `GET /api/ledger/series` (the TigerData continuous aggregate). Climbs live as settlements land. |
| Channel Viewer | Per claim, the exchange on its channel: portal form fill, email, fax, wholesaler chat. The proof that the agent worked the PBM's real door. |
| Pharmacist Phone | The iMessage digest and exceptions as the pharmacist sees them |

### 12.1 Theming

One component set, two themes, switched at runtime from a control in the header and persisted per viewer. Both are DORFic (Daylight, Orange, Red, Futurism, graphic): the industrial sub-genre of Frutiger Aero, ported from the team's Lovable design.

| Theme | Character |
|---|---|
| Frutiger Aero (default) | Daylight white field with a faint hex grid, an orange-to-red light streak and low-poly shards; frosted white glass panels with corner bolts; glossy orange pill buttons; hex status lights; orange monospace money; blueprint-grid chart and decision tree with glowing orange traces |
| Dark Aero | The same skin on smoked black glass with an orange edge glow and an orange hex grid |

Rules:

- Themes are CSS variables on `data-theme="aero|dark"` at the root (`apps/dashboard/app/globals.css`). Components never hardcode colors, radii, shadows, or backgrounds. A saved choice from the retired Light theme falls back to Frutiger Aero.
- Status is a hex indicator light plus an icon and a label (`components/ui/Pill.tsx`), never color alone. Orange is the brand, so it never signals a status by itself.
- Layout, data, and WebSocket behavior are identical across themes. Switching is instant and never reloads. At 1100 px and wider the home page fits one screen with no page scroll.
- The PMS mock at `/pms` keeps its own fixed legacy look in every theme (it is the store's existing software). The presenter page at `/presenter` has a fixed Dark Aero utility skin with large touch targets.
- Legibility holds in both themes: words use darker text-safe tones, the bright palette only fills orbs, traces and buttons, and money values sit on a solid backing.

## 13. Infrastructure

| Component | Tool | Notes |
|---|---|---|
| Runtime | Bun + TypeScript, workspace monorepo | `packages/contracts` shared by every app |
| Agent runtime | `apps/api`, `Bun.serve` | Single service, async loop, WebSocket to dashboard at `/ws/live` |
| PBM Sim | `apps/pbm-sim`, `Bun.serve` + simple HTML | Separate process and in-memory datastore; switch, dev door, portal, inbox, fax line |
| Browser agent | Playwright driven by the agent model | Fixed field map; scripted fallback if it flakes |
| Agent model | Google Gemini `gemini-3.8-flash` (override with `AGENT_MODEL`) via `@google/genai`, key in `AGENT_API_KEY` | Invoked on MARGINAL, evidence extraction, negotiation, portal/fax reading (`apps/api/src/agents/llm.ts`) |
| Messaging | Photon Spectrum SDK (`spectrum-ts`), in-process in the API | `PHOTON_PROJECT_ID`/`PHOTON_PROJECT_SECRET`; cloud iMessage for the pharmacist; WhatsApp Business to the wholesaler. The SDK's `app.messages` loop receives, so no public URL is needed. |
| Email | Mock mailbox inside PBM Sim | Optional: a hosted inbound/outbound email service if time allows |
| Fax | Mocked fax line inside PBM Sim | Bandwidth offers T.38 SIP trunking but no fax API, so it would need self-hosted fax software. A real fax API provider (e.g. Telnyx Programmable Fax) is the upgrade path, not required. |
| Voice (stretch) | ElevenLabs STT + TTS | Self-implemented loop; digest recap (AGT-09) and phone negotiator (AGT-08) only |
| Ledger | Capital One Nessie REST | Version probe at T+0 |
| Database | TigerData (Postgres + TimescaleDB) via `Bun.sql` | In-memory store when `DATABASE_URL` is empty. Seeded with 60 claims, ~18 underwater. |
| Frontend | `apps/dashboard`, Next.js + WebSocket | Dashboard plus the PMS mock cashier terminal; CSS-variable theming (12.1). Proxies `/api` and `/sim` so the browser needs no CORS. |

## 14. Trust & Safety Model

This system makes financial claims and files legal appeals. Every safeguard below must be functional before the demo.

1. **PBM decisions are deterministic, never model-generated.** The engine concedes on a rule: completeness at or above threshold and all required fields present.
2. **Every appeal is reproducible from source documents.** Each stores the invoice PDF, statute text, rulebook and spec version, and completeness score. If we cannot reproduce it, we do not file it.
3. **No claim is filed without complete evidence.** Incomplete packets route to remediation or escalation. A low win rate dressed up as volume is the failure mode this rule prevents.
4. **Abandonment is a first-class outcome.** Logged with reason and reported honestly in the digest and dashboard.
5. **No PHI touches persistent storage or leaves the vault.** Synthetic patient data only; claim records carry an opaque `patient_ref`.
6. **The ledger is append-only.** Corrections post reversing entries.
7. **The pharmacist owns the policy.** Nothing is filed outside the standing authorization without an explicit approve.
8. **Mocks are labeled.** PBM Sim personas are modeled on public procedures and presented as mocks, with no real logos or brand assets.
