# Reference data (agent side)

What RxSolve knows, as opposed to what the PBM Sim knows (`apps/pbm-sim/data/`). The two are
deliberately separate: our spec of a PBM can be wrong; the PBM Sim is the ground truth.

| File | Owner | Contents |
|---|---|---|
| `specs.json` | P2 (RES-01) | Our versioned model of each PBM's appeal spec: channel, required fields, `required_fields_basis` (verified vs modeled), `real_channels`, `sources[]` |
| `statutes.json` | P2 (RES-01) | Per-state citation, entitlement text, appeal window (`window_calendar_days` as the statute states it, `window_business_days` as the lower bound the deadline clock counts), remedy, regulator, source |
| `invoices.json` | P1 | Wholesaler invoice lines (X12 810-style) keyed by NDC; `unit_cost` is per unit dispensed |
| `nadac.json` | P1 | NADAC per-unit fixture (no real NADAC API) |
| `contracts.json` | P1 | Contract rate per unit, keyed `"<plan>|<ndc>"` |
| `drugs.json` | P3 | Display names for NDCs on the dashboard and cashier terminal |

`invoices.json` holds two demo rows with a deliberate null (NDC 16714029201 `invoice_number`, NDC 60505260901 `invoice_date`) for the RXS-0007/0008 wholesaler beat; the PBM Sim personas require those fields where `specs.json` does not. NDC 00093736598 (RXS-0009) has a null `invoice_number` and `wholesaler_unavailable: true`: the wholesaler stub refuses for that NDC only, so the claim is denied for a missing field it can never get and ends ABANDONED with a pharmacist text.

RES-01 is done: every spec and statute carries a cited source and a version. Known caveats:

- Appeal windows: the statute's calendar window is stored next to `window_business_days`, which is the
  conservative business-day lower bound the deadline clock uses (NC 6, GA 10, default 20; TN 7 as stated).
- GA (O.C.G.A. 33-64-9) does not key on acquisition cost; its entitlement text says so.
- CVS Caremark and Express Scripts `required_fields` are modeled, not verified (see `required_fields_basis`).

`apps/api/src/agents/evidence.ts` builds the appeal packet from these files. A spec may carry an optional
`state_rules` map (state to extra required fields) that is scored on top of `required_fields`.
