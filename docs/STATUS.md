# Status

Update this as work lands. Mark a ticket done when its "Done when" in `TICKETS.md` is met.

## Walking skeleton (2026-10-10)

`bun test` and `bun run dev` + `bun seed` run the whole demo path on local doubles: RXS-0001 is filed, denied for the TN wholesaler attestation, remediated, refiled, approved and settled ($6.40 + $1.60 fee); email and fax claims settle; CLEAR, MARGINAL and out-of-policy claims land where they should. Every ticket below now means "replace the double with the real thing behind the same interface".

## Tickets

| Ticket | Owner | Status | Notes |
|---|---|---|---|
| INF-01 | P1 | done | Nessie: classic v1 at `https://api.nessieisreal.com`; key valid (201 on a write, a fake key gets 401); `bun probe` is read-only. Photon: `bun api` logs `spectrum: iMessage connected`. Keys and Photon project id go to the group chat by hand, never the relay |
| INF-02 | P1 | done | TigerData schema bootstrap, health 200 (`db=tigerdata`) and `/ws/live` balance replay verified; RXS-0001 came back `SETTLED` with its appeal, transcript and ledger totals after an API restart (2026-10-11). PBM Sim ticket ids now start from boot time, since a constant start collided with persisted appeals |
| INF-03 | P1 | done | Portal/inbox/fax doors implement the logged P2 contracts; seed expands 6 templates to 60 (18 underwater, 39 clear, 3 marginal); local HTTP integration covers all three adapters and boundary test passes |
| INF-04 | P1 | done | Live-verified 2026-10-11 on RXS-0001 (`LEDGER_BACKEND=nessie`, `ADAPTER_MODE=real`): PBM-PORTAL -$6.40, PH-MEADOWBROOK +$4.80, RXSOLVE-PLATFORM +$1.60. Transactions need `status: "completed"`; balances are derived from completed deposits/withdrawals because the sandbox `balance` field never changes. Settlement refuses a claim that already has a remittance. Accounts live under the `RxSolve Ledger` customer. `local` stays the default for tests |
| INF-05 | P1 | done | Verified 2026-10-11 on the full stack (local doubles) with the six demo claims: RXS-0004 CLEAR short-circuits, RXS-0001..0003 walk evidence then their portal/email/fax doors and settle, RXS-0006 (over the $100 limit) raises an exception instead of filing, RXS-0005 (MARGINAL, no model key) raises an exception. Dashboard feed shows correct countdowns (e.g. `Due in 8d 18h · 2026-10-19` at 05:54Z on 10-11); the clock re-renders each minute at day/hour granularity |
| INF-06 | P1 | done | Deterministic named-field denials, missing-evidence approval, and PBM_FAX deny-first/rebuttal concession implemented and tested through the local doors |
| RES-01 | P2 | done | Specs, statutes, personas cited (NC, GA, default; CVS Caremark, Express Scripts, OptumRx). Open: CVS and Express Scripts form field labels and Express Scripts window/SLA not found in public sources; GA statute read from an older codification; TN citation not re-verified |
| AGT-01 | P2 | done | CLEAR/UNDERWATER deterministic; MARGINAL resolved via `extract`, stays MARGINAL (pharmacist exception) with no `AGENT_API_KEY` or on model error |
| AGT-02 | P2 | done | Entitlement extracted by the agent model (fixture text with no `AGENT_API_KEY` or on error; citation always from the fixture); appeal and invoice PDFs written locally to `out/evidence/`; completeness scored against spec `required_fields` plus optional `state_rules`. Wholesaler documents added by negotiation are not re-rendered into the PDF |
| AGT-03 | P2 | done | Scripted and Playwright portal drivers; scripted driver passes end-to-end against the local PBM Sim portal door. Browser mode remains optional and was not exercised. Writes `portal_form_*`/`portal_status_*` snapshots (PNG in browser mode, unexercised) into `attachments`, served by `/api/artifacts/:name` |
| AGT-04 | P2 | done | Email adapter passes end-to-end against the local PBM Sim inbox door, including named-field denial and same-thread refile. Records `email_sent_*`/`email_reply_*` `.txt` artifacts in `attachments` |
| AGT-05 | P2 | done | Fax adapter passes end-to-end against the local PBM Sim fax door, including PDF return parsing and same-ticket rebuttal. Fax PDFs already flow through `/api/artifacts/:name` |
| AGT-06 | P2 | done | Missing-field remediation, PDF rebuild/refile, bounded rebuttal, and abandonment pass through the local PBM Sim doors. Wholesaler WhatsApp remains stubbed without Photon Business credentials; PBM_FAX now deterministically disputes a complete first round and approves the rebuttal. Wholesaler reply reading is model-first with a quote-verification guard (regex fallback with no key). Plain-text demo claims: RXS-0007 (email, missing invoice number) and RXS-0008 (fax, missing invoice date), tested in `wholesaler-demo.test.ts`; a portal claim missing the invoice number cannot be filed because our spec requires it |
| AGT-07 | P2 | blocked | Digest/reply code and offline tests complete; sender authorization uses exact normalized matching. Live Photon send returned `PERMISSION_DENIED` because the pharmacist phone is not registered as a project user; live reply test awaits registration |
| AGT-08 | P2 | done against the simulated rep | Stretch. After one rebuttal, a second dispute calls the rep once when `PHONE_REP_URL` or `PHONE_MODE=sim` is set (else supervisor escalation as before). WebSocket audio loop with ElevenLabs STT/TTS, stub text codec without creds; the simulated rep (`adapters/phone-sim/rep.ts`) concedes by rule when the statute and figure are cited. Bounded to 3 turns, call stops at the appeal deadline, failure abandons with an exception ping. Not run against real ElevenLabs or telephony; PBM Sim's own rep line (P1) is not built |
| AGT-09 | P2 | blocked | Voice recap code and offline tests complete; real verification needs an ElevenLabs key/voice ID and the pharmacist phone registered with Photon |
| UI-01 | P3 | in progress | Responsive dashboard shell and `/ws/live` hook with event-frame checks/reconnect backoff; workspace typecheck/dashboard build pass, live replay visual check pending |
| UI-02 | P3 | in progress | PMS mock is now its own surface at `/pms` (own root layout and stylesheet, no `/ws/live`, no RxSolve state): dispensing queue, submit B1, payer response or rejection, NCPDP disclosure. RxSolve home lists claims from the feed only. Browser check against the real PBM Sim switch pending |
| UI-03 | P3 | in progress | Claims feed shows event-derived amount, PBM, channel, and ticking appeal deadline; verify displayed dollars against Nessie after INF-04 lands. Per-claim status tree at `/claims/[claimId]` ("See status" on each claim row) derives the taken path, denial rounds and our-time vs outside-time split from existing `/ws/live` events; not yet checked against a live multi-round claim |
| UI-04 | P3 | in progress | Per-claim transcript lives in the claim journey and status tree (pipeline board and channel viewer removed 2026-10-11); pharmacist card is a digest button showing `meta.delivered`, the demo phone is the real device; full live run across all channels pending |
| UI-05 | P3 | todo | Requires two consecutive timed end-to-end runs with no manual intervention; not yet verified |
| UI-06 | P3 | todo | README exists; screenshots, backed-up recording, sponsor checklist verification, and MLH form submission remain manual |
| UI-07 | P3 | in progress | Lovable DORFic design ported 2026-10-11: two skins (Frutiger Aero default, Dark Aero), hex-grid scene, glass panels with corner bolts, hex status lights, claim plates with hex progress, blueprint chart, circuit-board decision tree with full-screen view, glossy presenter page. Verified by a Playwright run of the held demo flow in both themes: home fits 1440x900 with no page scroll, no console errors, no horizontal overflow at 390 px. Formal contrast audit still pending |
| UI-08 | P3 | in progress | Status screen artifacts drawers, presenter hold controls (PBM release, wholesaler reply, release all) and the unified cashier claim list implemented; unit, typecheck and isolated build pass, mocked-WS browser check done; live check against the PBM Sim release door pending until that door lands |

## Off-ticket work

| Work | Owner | Status | Notes |
|---|---|---|---|
| Historical opportunity scan (`/scan`, `POST /api/opportunity-scan`) | MasonMines2006 | done, not pushed | Deterministic CSV triage with five example files; evidence in `docs/testing/opportunity-scan.tdd.md`. Touches `routes/core.ts` (P1) and the dashboard (P3); owner sign-off still needed before pushing |
| Scan review queue and policy preview | MasonMines2006 | done, not pushed | Browser preview of the auto-file limit over `READY` and `NEEDS_REVIEW` claims |
| Scan handoff (`POST /api/opportunity-scan/handoff`) | MasonMines2006 | done, not pushed | Selected scan rows become real claims and run through the unchanged orchestrator; runs under the saved `policy.auto_file_max` and never writes it (the typed limit is preview only); `GET /api/opportunity-scan/policy` reports it. Header-alias fix: an `Rx Number` column no longer maps to the claim ID. Adds `routes/scan.ts` and one registration line in `server.ts` (P1), so P1 sign-off is needed before pushing. Verified on local doubles only (`LEDGER_BACKEND=local`, `ADAPTER_MODE=direct`); not run against Nessie, TigerData or the real portal/email/fax adapters. Only the six NDCs in `fixtures/invoices.json` can be handed over |

## Stubbed integrations

| Integration | Stubbed? | Detail |
|---|---|---|
| Agent model (Gemini) | no | Live-verified 2026-10-10 with `AGENT_API_KEY`: `gemini-3.8-flash` accepted; simple, nullable + enum + array schemas via `responseJsonSchema`, all three thinking levels, and PDF `inlineData` input return parsed output; an invalid key throws so callers fall back to their deterministic paths |
| Nessie | no (with `LEDGER_BACKEND=nessie`) | Live sandbox settlement verified. The old `RxSolve Demo` customer is abandoned: its accounts hold a dollars-era opening balance and PBM-PORTAL has a status-less withdrawal that Nessie cannot list or delete |
| Spectrum iMessage | partial | SDK connects with project credentials, but live sends require the pharmacist phone to be registered as a project user. Dashboard phone mock remains available; `PHARMACIST_PHONE` restricts inbound commands |
| Spectrum WhatsApp / SMS (wholesaler) | yes | Without a delivered Photon send the wholesaler replies instantly in the channel viewer (`WHOLESALER_STUB=auto`; `silent` never replies, `manual` waits for `POST /api/dev/wholesaler-reply`). Live needs `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` plus `WHOLESALER_CONTACT`; a failed WhatsApp send retries as SMS over the iMessage line |
| ElevenLabs | stretch | Not on the core demo path; digest is text-only without a key. Phone negotiator (AGT-08) runs on a stub text codec without `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`, against the in-process simulated rep (`PHONE_MODE=sim`); real telephony is out of scope, `PHONE_REP_URL` is the hook point |
| TigerData | partial | `DATABASE_URL` connects and schema bootstrap succeeds; process-restart claim persistence is not yet verified |
| PBM portal / email / fax | yes (by design) | Deterministic local PBM Sim doors match adapter contracts; no real PBM connections |
| Fax transport | yes (by design) | Mock fax line; no real fax provider |

## Blockers

- Before the demo, empty the shared TigerData tables: rows from earlier rehearsals (RXS-0002/0003, $9.60) are in `recovered_to_date` and the chart but not on the fresh Nessie accounts.
- AGT-07 live digest/reply checks await pharmacist-number registration in the Photon project.
- AGT-09 live voice verification is stretch and needs an ElevenLabs key/voice ID and the registered Photon phone.
- UI-05/06 still need the timed live rehearsal and submission assets/form work.
