# RxSolve: Demo & Submission

Part of the technical design. See [DESIGN.md](DESIGN.md) for the flow being demoed and [TICKETS.md](TICKETS.md) (UI-05, UI-06) for the gate and submission tickets.

## 20. The Demo Moment

### 30-second pitch script

> "Meadowbrook Pharmacy fills 1,800 scripts a week. Every PBM pays some of them below what the drug cost, and every PBM wants the appeal through a different door: a web portal, an email, a fax. Nobody files, because each one is five dollars and twenty minutes. RxSolve catches it at the register, builds the proof from the pharmacy's own invoice, and works whichever door that PBM actually uses. The pharmacist gets one text a day. Here's a live one..."

### E2E sandbox preflight

Only run this with the Capital One Nessie sandbox key in the gitignored root `.env`; never use a production ledger. Set `LEDGER_BACKEND=nessie`, `NESSIE_KEY`, `ADAPTER_MODE=real`, and the Gemini `AGENT_API_KEY`. Keep `PORTAL_MODE=scripted` (the default) so the demo does not depend on Playwright.

Starting the API with `LEDGER_BACKEND=nessie` performs real sandbox POSTs on first boot: it creates/reuses the synthetic `RxSolve Ledger2` customer and named Checking accounts, each opened at its own sandbox balance (pharmacy $48,250, platform $12,000, each PBM $2,000,000; see `DEMO_OPENINGS` in `ledger/nessie.ts`). A settled claim then posts two more Nessie transfers (PBM to pharmacy, pharmacy to platform), each a paired withdrawal and deposit in integer cents with `status: "completed"`. Balances are the opening balance plus completed deposits minus completed withdrawals, because the sandbox never updates an account's `balance` field. A claim that already has a remittance is refused before any money moves, so to rehearse the same claim again, delete its rows from TigerData first (or empty the tables). Do not start the API with a key unless these sandbox writes are intended.

1. Run `bun run dev` and confirm `curl http://localhost:8000/api/health` reports `db: "tigerdata"` and `ledger: "nessie"`.
2. Run `bun seed RXS-0001`; wait for the portal denial, local wholesaler remediation, refile, and `SETTLED` stage in the dashboard.
3. Optionally run `bun seed RXS-0002` and `bun seed RXS-0003` to exercise the email and fax adapters; verify the real sandbox balances and recovered-over-time chart after each settlement.

The Photon pharmacist phone is not yet registered as a project user, so do not treat a digest send as a live-phone pass until that is fixed. Tests keep `DATABASE_URL=""` and `LEDGER_BACKEND=local`; never run tests against the shared TigerData database.

### 20.1 The scripted beat

Three PBM personas, each modeled on a real PBM's public appeal procedure. Open by naming them: "These three mock PBMs are modeled after CVS Caremark, Express Scripts, and OptumRx."

0. **Two windows.** Open the pharmacy system at `/pms` (the store's existing dispensing software, simulated) and RxSolve at `/` side by side. Say: "RxSolve sits beside the claim switch and reads the claim feed; the pharmacy changes nothing." Bill a prescription in `/pms`; the claim appears in the RxSolve Claims list on its own.
0b. **Presenter page.** On a second device open `/presenter` (not linked from the product). It lists only claims waiting on the PBM ("Release", "Release all") or on the wholesaler (reply field, "Send reply"). Hold mode needs `PBM_SIM_HOLD=1` for the PBM sim and `WHOLESALER_STUB=manual` for the API.
**Primary flow: the scanner.** Open `/scan` and drop `seed/demo-claims.csv` anywhere on the page (regenerate it with `bun scripts/demo-claims-csv.ts > seed/demo-claims.csv` so the fill date is yesterday's business day and the appeal window is open). The scan lists five claims: one fairly paid, four ready. Select the four ready rows and Send. The beats below then play out on the dashboard; the PMS rows (`/pms`) are the same five claims and remain the alternative way in. Claim ids `DEMO-1001..1005` are refused on a second send, so empty the tables between rehearsals.

1. **Cleared claim.** Amlodipine (`DEMO-1002`, `RX-91B2-0377`, NC) shows as paid fairly in the scan and is not sent. The PBM paid at or above cost, so RxSolve takes no action. Say: "Correct claims are left alone."
2. **Portal, straight through.** Ring up Metformin 1000 (`RX-7F3A-0412`, NC). The claim underpays, the browser agent fills the Caremark-style form with the invoice attached, and the PBM approves in the first round. The ledger moves.
3. **Email, denied then recovers.** Ring up `RX-3D5E-0611` (Sertraline, claim RXS-0007) or `bun seed RXS-0007`. The PBM denies for a missing invoice number, the agent texts the wholesaler, and the refile is approved.
   - **Plain-text wholesaler beat (needs `AGENT_API_KEY`, `WHOLESALER_STUB=manual`, presenter reply or a real SMS).** Reply in plain words, e.g. "Invoice number is INV-55120" or "it's 55120". The model reads the value and must quote it from the reply; with no key only `INV-...` and `YYYY-MM-DD` forms parse.
4. **Email, denied and unrecoverable.** Ring up `RX-5C19-0829` (Losartan, claim RXS-0009). The PBM denies for a missing invoice number, the wholesaler cannot locate it (its invoice line carries `wholesaler_unavailable`, or the presenter types a refusal), the claim is abandoned, and the pharmacist gets a text. The ledger does not move. Say: "When RxSolve cannot fix it, a human hears about it once."
5. **Fax (optional if time is short).** `RX-8A21-0702` (Montelukast, claim RXS-0008) asks for the invoice date: reply "dated October 1st, 2026". The refile is approved in round 2; the fax reply is a scanned PDF the agent reads.
6. **Ledger.** Remittance adjustments and fee transfers move real Nessie balances, and the recovered-over-time chart (TigerData continuous aggregate) steps up with each settlement.
7. **Digest.** The pharmacist's phone receives the daily digest. One word replies. (Stretch: it carries a voice recap.)
7b. **Historical scan (optional, ~20s).** Open `/scan`, pick **Ready for RxSolve handoff**, run it, and say: "Here is last month's file: this much was underpaid and this much is recoverable." Send the ready claims; they join the same pipeline under the saved $100 policy (three settle, the $130 one waits as an exception, the drug with no invoice is rejected).
8. **Stretch: phone (ElevenLabs).** On a disputed denial, the agent calls the PBM rep and wins the argument on the statute.

| Moment | What it proves |
|---|---|
| Three different doors, one agent | The product is channel-agnostic, not a one-form script |
| Denial, wholesaler fetch, refile | The system handles failure, not just the happy path |
| Scanned fax read back | Perception, not just API calls |
| Balance moves on the ledger | The money is real, not a JSON constant |
| One digest a day, one exception | It scales to a flood of claims without spamming a human |
| Phone call (stretch) | The agent negotiates, not just files |

> **The single most important demo moment.** The agent working a PBM's own door (the form filling itself, the denial landing, the missing document fetched, the refile approved) with no human touching it.

### 20.2 Prize-moment mapping

| Sponsor | Moment judges will verify |
|---|---|
| Photon | Daily digest and live exception on the pharmacist's iMessage; wholesaler remediation over WhatsApp/SMS |
| Nessie | Recovery visibly moving real balances between pharmacy, PBM, and platform accounts |
| TigerData | The recovered-over-time chart climbing live as settlements land, read from a continuous aggregate over the `ledger_events` hypertable (the chart's caption names the source) |
| ElevenLabs (stretch) | Only if the stretch lands: voice recap in the digest; phone negotiation with the PBM rep |
| Frutiger Aero track | Flip the dashboard between Frutiger Aero and Dark Aero live during the run; the PMS mock at `/pms` keeps its own fixed look, which shows it is a separate system |

## 21. Submission Assets

- **README:** problem, architecture, sponsor integration map, honest note on every mocked integration
- **Screenshots:** terminal, portal fill, channel viewer, dashboard, ledger panel, pharmacist phone
- **Demo recording:** captured as backup before the live demo, never skipped
- **MLH pre-submission form:** project name, team members, one-liner. Filed before 11:59 PM. P3 owns this.
- **Per-prize checklist:** each sponsor challenge's stated submission requirements, verified individually

### What to say if asked what is mocked

The PBMs are mocks, modeled on the public appeal procedures of CVS Caremark, Express Scripts, and OptumRx, with no real logos or integrations. Fax transport is simulated. Everything on our side is real: detection, evidence assembly, statutory citation, per-channel filing, negotiation, remediation, and settlement run against real message and ledger infrastructure.

The pharmacy system and claim switch speak NCPDP-shaped messages (JSON with the real field IDs, not the wire format), and remittances are 835-style records. We call them "NCPDP-shaped", never "compliant".

Because RxSolve talks to each PBM through an adapter, pointing it at a real PBM is a new adapter and a spec, not a redesign.
