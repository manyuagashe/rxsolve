# RxSolve: Tickets

Part of the technical design. See [DESIGN.md](DESIGN.md) for architecture and [BUILD_PLAN.md](BUILD_PLAN.md) for the schedule and shared `.env`.

| Phase | Tickets |
|---|---|
| P1 | INF-01 to INF-06 |
| P2 | RES-01, AGT-01 to AGT-07; stretch AGT-08, AGT-09 |
| P3 | UI-01 to UI-07 |

## P1: Infrastructure, PBM Sim & Ledger

### INF-01 | T+0 to T+1 | Sponsor key sprint (Nessie, Photon)

Get the core sponsor APIs answering before anything else is built. ElevenLabs is stretch: probe it only if a key is already in hand.

```bash
# --- Nessie: probe the version FIRST ---
curl "https://api.nessieisreal.com/customers?key=$NESSIE_KEY"
# 401 or 404 => you are on v2. Switch to header auth against /v2/accounts

# --- ElevenLabs (stretch, optional): one TTS call ---
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/$VOICE_ID" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"RxSolve online","model_id":"eleven_turbo_v2_5"}' \
  --output probe.mp3

# --- Photon: Photon's "send your first message" scaffold gives PROJECT_ID / PROJECT_SECRET ---
# Put them in .env as PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET, register the pharmacist's phone
# as a project user, then `bun api` should log "spectrum: iMessage connected".
```

`bun probe` (scripts/probe-sponsors.sh) runs the Nessie and ElevenLabs checks.

**Done when:** Nessie and Photon return success. Group chat has every key, the confirmed Nessie version, and the Photon project id.

### INF-02 | T+1 to T+2 | Bun API service, TigerData, WebSocket

Scaffolded: `apps/api/src/server.ts` (`Bun.serve` routes plus `/ws/live`), `db.ts` (TigerData or in-memory behind one `Collection` interface; tables, hypertables and the `recovery_series` continuous aggregate in `ensureSchema`), `events.ts` (the bus). Remaining: point `DATABASE_URL` at a Tiger Cloud service and confirm the schema is created.

**Done when:** `curl localhost:8000/api/health` returns 200, a WebSocket client receives events, and claims persist in TigerData across a restart.

### INF-03 | T+1 to T+3 | PBM Sim: switch, decision engine, seed

A separate service (own process, own datastore, port 8100). Deterministic. The switch accepts NCPDP-shaped B1/B2/B3 JSON and returns an NCPDP-shaped response (DESIGN.md section 5.3).

```python
def adjudicate(claim) -> Reimbursement:
    price = MAC_LIST[claim.pbm].get(claim.ndc, claim.paid_amount)
    copay = COPAY_SCHEDULE[claim.plan](price)
    return Reimbursement(paid=round(max(price - copay, 0), 2), pbm=claim.pbm, adjudicated_at=now())
```

Seed 60 claims across three personas: ~18 UNDERWATER (MAC below acquisition cost), the remainder CLEAR, and 3 deliberately MARGINAL. Each persona carries a seeded response delay and a partial-evidence threshold.

**Done when:** seeded claims adjudicate on load, the underwater count matches, every claim has a `fill_date` inside its appeal window, and PBM Sim imports nothing from the agent codebase.

### INF-04 | T+3 to T+4 | Nessie ledger: accounts and settlement

```python
async def settle_recovery(claim, delta, fee_pct=0.25):
    await nessie.transfer(from_=claim.pbm_account, to_=claim.pharmacy_account, amount=delta)
    await nessie.transfer(from_=claim.pharmacy_account, to_=PLATFORM_ACCOUNT,
                          amount=round(delta * fee_pct, 2))
```

**Done when:** accounts exist (pharmacy, three PBMs, platform, patients), a test remittance moves a real balance, the fee transfer posts, and each deposit has an 835-style record in `remittances`.

### INF-05 | T+4 to T+6 | Orchestrator + deadline clock

The demo's spine. Copy the loop from DESIGN.md section 9, including the standing-authorization gate.

**Done when:** a CLEAR claim short-circuits; an UNDERWATER claim walks evidence then file via the PBM's adapter; an out-of-policy claim raises an exception instead of filing; the clock counts down correctly in the dashboard feed.

### INF-06 | T+7 to T+9 | Per-persona concession rules + escalation path

No model in the loop.

```python
def decide(spec, evidence) -> Decision:
    if evidence.completeness >= 1.0:
        return Decision("APPROVED")
    if evidence.completeness >= spec.partial_threshold:
        return Decision("DENIED", reason="missing_field", field=first_missing(evidence, spec))
    return Decision("DENIED", reason="insufficient_evidence")
```

**Done when:** a complete packet wins on each persona, a partial packet denies with a specific named field, one persona denies first and approves on rebuttal, and escalation files correctly.

## P2: Research, Agents, Channels & Messaging

### P2 dependencies and execution waves

| Ticket | Depends on | Notes |
|---|---|---|
| RES-01 | none | Feeds the fixtures every other P2 ticket reads |
| AGT-01 | none | Touches `agents/watcher.ts` only |
| AGT-07 | none inside P2 | Needs INF-02 and INF-04 (P1) for ledger data; touches `agents/notifier.ts`, `messaging/` |
| AGT-02 | RES-01 | Statute and spec data come from the fixtures; touches `agents/evidence.ts` |
| AGT-03 | AGT-02 | Portal adapter; needs the INF-03 portal door (P1) |
| AGT-04 | AGT-02 | Email adapter; needs the INF-03 inbox door (P1) |
| AGT-05 | AGT-02 | Fax adapter; needs the INF-03 fax door (P1) |
| AGT-06 | AGT-02, AGT-03 | One channel through the adapter first, then a second; needs INF-06 (P1) for the PBM_FAX persona |
| AGT-08 | AGT-06 | Stretch |
| AGT-09 | AGT-07, UI-05 | Stretch; start only after the demo gate is green |

Waves (tickets in a wave touch disjoint files and run in parallel):

1. RES-01, AGT-01, AGT-07
2. AGT-02
3. AGT-03, AGT-04, AGT-05
4. AGT-06
5. Stretch: AGT-08, AGT-09

### P2 status

Orchestrator updates this table as work lands. Status: `not started`, `in progress`, `blocked`, `done`.

| Ticket | Status | Notes |
|---|---|---|
| RES-01 | done | Cited specs and statutes; D.0 IDs verified; 835 mapping partly unverified; CVS and Express Scripts form fields and Express Scripts window not public (see STATUS) |
| AGT-01 | done | MARGINAL resolved by agent; falls back to pharmacist exception with no key or on error (tests unrun: bun unavailable) |
| AGT-02 | done | Entitlement via `extract` with fixture fallback; local appeal and invoice PDFs in `out/evidence/`; completeness vs spec plus state extras; tested for TN, NC, GA, default |
| AGT-03 | done | Scripted and Playwright drivers; scripted driver integrated over HTTP with the local PBM Sim portal door (browser mode optional) |
| AGT-04 | done | Email adapter integrated over HTTP with the local PBM Sim inbox door, including same-thread refile |
| AGT-05 | done | Fax adapter integrated over HTTP with the local PBM Sim fax door and PDF return parsing |
| AGT-06 | done | Remediate/refile, bounded rebuttal, and abandonment pass through local PBM Sim doors; WhatsApp is stubbed without Photon Business credentials; PBM_FAX denies the complete first round and concedes by deterministic rule on rebuttal |
| AGT-07 | blocked | Digest, exception asks, reply commands and exact sender authorization tested offline; live test awaits Photon project-user registration for the pharmacist phone |
| AGT-08 | done | Stretch; call loop tested against a simulated rep over local WebSocket; no real ElevenLabs or telephony run |
| AGT-09 | blocked | Code complete and tested offline; live voice note needs an ElevenLabs key/voice ID and a Photon-registered phone |

### RES-01 | T+0 to T+3 | PBM appeal procedure and NCPDP field research

Pull the public MAC appeal procedures for CVS Caremark, Express Scripts, and OptumRx from provider manuals and PBM pages. For each: submission channel(s), required fields, attachments, appeal window, response SLA. Write the result into `apps/api/src/fixtures/specs.json` (our model of each PBM) and `statutes.json` (replace every `TODO(RES-01)`) with the source URL and a version, and mirror what each PBM actually enforces into `apps/pbm-sim/data/personas.json`.

Also pull public payer sheets to verify the NCPDP D.0 field IDs and response fields used in DESIGN.md section 5.3, and the 835 adjustment fields used in section 5.4.

**Done when:** three versioned specs exist with cited sources, the NCPDP and 835 field lists in DESIGN.md are corrected against payer sheets, and a note records which channel assignment in DESIGN.md section 8.1 was kept or changed.

### AGT-01 | T+1 to T+3 | Adjudication Watcher

Deterministic on the happy path.

```python
def adjudicate(claim, invoices):
    acq = acquisition_cost(invoices, claim["ndc"], claim["fill_date"])
    delta = acq - claim["paid_amount"]   # entitlement is acquisition cost (DESIGN 7.1)
    if delta <= 0:
        return Verdict("CLEAR", 0.0)
    if delta <= MARGINAL_BAND:
        return escalate_to_agent(claim, delta)
    return Verdict("UNDERWATER", delta)
```

Scaffolded in `apps/api/src/agents/watcher.ts`: CLEAR and UNDERWATER work; MARGINAL currently raises a pharmacist exception instead of asking the agent.

**Done when:** a known-underwater claim returns UNDERWATER with the correct delta; a fair claim returns CLEAR with no model call; a MARGINAL claim is resolved by the agent (`agents/llm.ts`).

### AGT-02 | T+3 to T+5 | Evidence Builder

Fully agentic, shaped by the target PBM's spec.

**Done when:** a real appeal PDF exists with a correct section citation, a valid attached invoice, and a completeness score computed against that PBM's required fields, for at least three states.

### AGT-03 | T+5 to T+7 | Portal adapter + browser agent

Implement the `ChannelAdapter` interface (DESIGN.md 7.3). A Playwright browser agent fills the PBM Sim portal from a fixed field map, uploads the PDF, and reads the status page. Include a scripted fallback.

**Done when:** a claim is filed through the portal and the denial or approval is read back as a `Decision`, with the form fill visible in the channel viewer.

### AGT-04 | T+6 to T+7 | Email adapter

Compose the appeal with the PDF attached, send to the PBM Sim inbox, and parse the templated reply.

**Done when:** an email appeal produces an approval or a named-field denial, parsed into a `Decision`.

### AGT-05 | T+7 to T+8 | Fax adapter

Render a cover sheet plus evidence PDF, post to the fax line, and read the scanned-look reply PDF with vision/OCR.

**Done when:** a fax appeal returns a `Decision` read from the reply PDF.

### AGT-06 | T+7 to T+9 | Negotiation loop with wholesaler remediation

The demo beat, working on any channel through the adapter.

```python
if denial.reason == "missing_field":
    doc = await wholesaler.request_document(
        channel="whatsapp", to=claim.wholesaler_contact, ask=denial.field_name
    )
    await adapter.reply(denial.ticket, Reply(evidence=await ev.with_document(doc)))
```

**Done when:** the full deny, remediate, refile, approve sequence runs live on the portal channel without intervention, and at least one other channel completes the same loop.

### AGT-07 | T+9 to T+10 | Pharmacist notifier and digest

Spectrum iMessage: daily digest (manually triggerable for the demo), exception pings, standing-authorization policy, and replies like APPROVE, DETAILS, PAUSE.

**Done when:** a digest built from ledger data lands on a real phone, a reply changes state, and an out-of-policy claim produces an exception ping.

### AGT-08 | Stretch | Phone negotiator

ElevenLabs STT/TTS loop. Build against a simulated rep over WebSocket audio first, real telephony second. Record a backup call.

**Done when:** on a disputed denial the agent calls the rep, cites the statute, and the deterministic rule flips the decision to APPROVED.

### AGT-09 | Stretch | Digest voice recap

ElevenLabs TTS of the digest text, attached to the iMessage digest as a voice note and playable in the dashboard phone mock. Scaffolded in `apps/api/src/voice.ts`; it no-ops without `ELEVENLABS_API_KEY`, so the digest never depends on it. Start only after AGT-07 is done and the demo gate is green.

**Done when:** the digest arrives on a real phone with a voice note of the same numbers as the text.

## P3: Dashboard & Demo

### UI-01 | T+3 to T+5 | Next.js shell + WebSocket client

Structure over polish. Panels rendering live data. Style values come from CSS variables from day one (see UI-07).

**Done when:** all panels receive and render events from `/ws/live`, and no component hardcodes a color, radius, or shadow.

### UI-02 | T+5 to T+7 | PMS mock and cashier terminal

Do not cut this one. A dispensing screen that submits an NCPDP-shaped B1 claim and renders the response and a resolved badge. This panel makes the project read as a payments company rather than an appeals tool.

**Done when:** a test claim flows through the PMS mock to the PBM Sim switch end to end, the NCPDP-shaped response renders, and a resolved or in-flight badge shows.

### UI-03 | T+7 to T+9 | Recovery feed, pipeline board, ledger panel

Real numbers only. Kanban with deadline countdowns, PBM and channel shown per card.

**Done when:** every dollar shown on screen is reproducible in the Nessie transaction record.

### UI-04 | T+9 to T+10 | Channel viewer + pharmacist phone

Per claim, render the exchange on its channel (portal fill, email, fax, wholesaler chat) as it happens. Render the pharmacist's digest and exceptions as a phone mock.

**Done when:** the exchange renders live, step by step, during a full run-through on all three channels.

### UI-07 | T+9 to T+10 | Theme system: Frutiger Aero and Dark Aero (DORFic)

Token-based theming (DESIGN.md section 12.1). Define the variable set once (surfaces, text, accent, radius, shadow, blur, gradients), a switcher in the header, and the Aero skin: glass panels, gradients, glossy buttons, pill controls, background imagery. Persist the choice per viewer.

Start the token layer in UI-01 so no component hardcodes style values; this ticket is the skins and the switcher.

**Done when:** all panels, the PMS mock, and the pharmacist phone render correctly in both themes, the switcher flips them live without reload, and text and money values are legible in Aero.

### UI-05 | T+10 to T+11 | Demo gate

Go / no-go. Full run-through, twice, timed. Cut everything not green. Decide on the phone stretch.

**Done when:** two consecutive clean run-throughs with no manual intervention and no placeholder data.

### UI-06 | T+11 to T+12 | Submission assets

README, screenshots, demo recording, each sponsor-prize checklist verified. MLH form filed before 11:59 PM.

**Done when:** form submitted, checklist verified per sponsor, recording backed up.
