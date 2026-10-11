# RxSolve

A payments processor for pharmacies: every prescription claim resolves at or above acquisition cost. Underpaid claims are caught at the point of sale, proven with the pharmacy's own invoice, appealed through whichever channel the PBM accepts (portal, email or fax), and settled on a real ledger.

Design and plan: [`docs/`](docs/) ([DESIGN](docs/DESIGN.md), [BUILD_PLAN](docs/BUILD_PLAN.md), [TICKETS](docs/TICKETS.md), [DEMO](docs/DEMO.md), [STATUS](docs/STATUS.md)).

## Run it

Needs [Bun](https://bun.sh) ≥ 1.3 (`brew install oven-sh/bun/bun`).

```sh
bun install
cp .env.example .env     # empty values are fine: everything falls back to local doubles
bun run dev              # api :8000, pbm-sim :8100, dashboard :3000
bun seed                 # replay the seed claims through the PBM Sim switch
open http://localhost:3000
```

Or one process per terminal: `bun api`, `bun sim`, `bun dash`. Then `bun seed RXS-0001` runs just the demo beat (portal claim, TN attestation denial, wholesaler remediation, refile, settlement).

`bun test` runs the demo path end to end over real HTTP. `bun run typecheck` checks every workspace.

## Try the recovery opportunity scan

Open [http://localhost:3000/scan](http://localhost:3000/scan), choose one of six synthetic scenarios, and select **Run example CSV**. The examples cover mixed outcomes, high recovery, missing evidence, deadline risk, and alternate column names. RxSolve measures historical shortfalls and separates ready claims from exceptions. **Review N claims** then opens a review queue of ready and needs-review claims with an auto-file dollar limit, showing which claims would file on their own and which would wait for approval. The queue itself is a preview. **Send N claims to RxSolve** (after ticking the confirmation) is real: it posts to `POST /api/opportunity-scan/handoff`, which runs each accepted claim through the normal pipeline under the pharmacy's saved auto-file limit (the limit typed on the page is a preview only and is never saved), where it may be filed and settled. RxSolve prices handed-over claims from its own invoice data, so the file needs `Quantity` and `Rx Number` columns and a drug RxSolve has an invoice for. The sixth example, **Ready for RxSolve handoff**, is built for this.

For unfamiliar CSV formats, a configured model may map unknown column names to RxSolve's fixed eleven-field vocabulary. Only header names are sent to the model. CSV rows, dollar amounts, evidence checks, deadlines, classifications, and totals remain deterministic and are validated again after mapping.

## Layout and ownership

| Path | Owner | What |
|---|---|---|
| `packages/contracts/` | shared | Zod schemas and types for DESIGN §5.3 and every `/ws/live` event. Changing one means a line in `docs/DECISIONS.md`. |
| `apps/api/src/` (orchestrator, intake, ledger/, db, events, routes/core) | P1 | Agent runtime spine, Nessie ledger, deadline clock, standing-authorization gate |
| `apps/api/src/agents/`, `adapters/`, `messaging/`, `voice.ts`, `routes/messaging.ts` | P2 | Watcher, Evidence Builder, negotiation, channel adapters, Spectrum, ElevenLabs (stretch) |
| `apps/api/src/fixtures/` | P1 / P2 | Reference data; per-file owners in its README |
| `apps/pbm-sim/` | P1 | Standalone mock PBMs: claim switch, decision engine, portal/inbox/fax doors. Imports nothing from `@rxsolve/*`. |
| `apps/dashboard/` | P3 | Next.js dashboard, PMS mock cashier terminal, pharmacist phone, themes |
| `seed/`, `scripts/` | P1 / P3 | Seed claims and the seed/probe scripts |
| `tools/agent-coordinator/` | dev tooling | Agent-to-agent mailbox; not part of the product |

## How a claim flows

```
cashier (dashboard) --B1--> pbm-sim /switch/claim --tee--> api /api/feed/claim
  -> orchestrator: watcher -> evidence -> policy gate -> adapter (PBM's door)
  -> pbm-sim decides (deterministic) -> negotiation on denial -> settlement on approval
  -> every step is an event on ws://localhost:8000/ws/live -> dashboard
```

## What is real and what is mocked

| Integration | Status |
|---|---|
| PBMs (portal, email, fax) | Mocked by design in `apps/pbm-sim`, modeled on public CVS Caremark, Express Scripts and OptumRx appeal procedures. No real logos. |
| Fax transport | Mocked inside the PBM Sim |
| Nessie | Classic v1 adapter is implemented; live ledger requires `LEDGER_BACKEND=nessie` and `NESSIE_KEY`. The local ledger remains the default until live paired withdrawal/deposit settlement is verified |
| TigerData | Live when `DATABASE_URL` is set (hypertables + a continuous aggregate for the recovery chart); otherwise an in-memory store |
| Photon Spectrum (iMessage) | Live when `PHOTON_PROJECT_ID`/`PHOTON_PROJECT_SECRET` are set and the pharmacist phone is registered as a project user; otherwise the dashboard phone mock shows every message and its reply box drives the same commands (APPROVE, SKIP, DETAILS, PAUSE, RESUME, LIMIT) |
| WhatsApp / SMS to wholesaler | Stubbed unless Photon is connected with `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` and `WHOLESALER_CONTACT`: the wholesaler replies instantly in the channel viewer (`WHOLESALER_STUB=silent` makes it stay quiet to show the abandon path) |
| ElevenLabs (stretch) | Voice recap (AGT-09) and phone negotiator (AGT-08) are stretch goals; without keys the digest is text only; with a key the digest text is followed by a voice note (`channel.message` with `audio_url`). The phone negotiator runs offline on a stub text codec against the simulated rep (`PHONE_MODE=sim`); `PHONE_REP_URL` points it at a real audio line |
| PBM adapters | `ADAPTER_MODE=real` uses the scripted portal, email, and fax adapters over HTTP to the local PBM Sim doors; `ADAPTER_MODE=direct` keeps the JSON dev-door fallback. Real PBM services remain mocked by design |
| Opportunity scan AI | Optional and bounded: when `AGENT_API_KEY` is set, the model can map unknown CSV header names only. Claim rows never leave deterministic parsing, and the scan works without a key for documented aliases. |

Current status of each stub is in [docs/STATUS.md](docs/STATUS.md).

## Photon setup

The Spectrum wiring follows Photon's "send your first message" scaffold: put the project's `PROJECT_ID` and `PROJECT_SECRET` in `.env` as `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`. On Free and Pro plans the shared iMessage line only reaches phones registered as project users in the Photon dashboard, so add the pharmacist's phone there. Agents get the SDK reference from `.claude/skills/spectrum/`.
