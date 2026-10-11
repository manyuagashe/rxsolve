/** Core API: health, claim feed, claims, ledger. Owner: P1. (/ws/live lives in server.ts.) */
import { config } from "../config";
import { getDb, recoverySeries } from "../db";
import { bus } from "../events";
import { SwitchFeed, toClaim } from "../intake";
import { ledgerSummary } from "../ledger/settle";
import { processClaimSafe } from "../orchestrator";
import { drugName } from "../reference";

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

export const coreRoutes = {
  "/api/health": {
    GET: () => Response.json({ status: "ok", ledger: config.ledgerBackend, adapters: config.adapterMode, db: config.databaseUrl ? "tigerdata" : "memory" }),
  },

  /** Called by the PBM Sim switch for every paid claim. ?process=0 stores without running the pipeline. */
  "/api/feed/claim": {
    POST: async (req: Request) => {
      const parsed = SwitchFeed.safeParse(await req.json());
      if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
      const claim = toClaim(parsed.data);
      await getDb().claims.upsert(claim);
      bus.emit("claim.received", claim.claim_id, { ...claim, drug: drugName(claim.ndc) });
      if (new URL(req.url).searchParams.get("process") !== "0") void processClaimSafe(claim.claim_id);
      return Response.json(claim);
    },
  },

  "/api/claims": { GET: async () => Response.json(await getDb().claims.find()) },

  "/api/claims/:id": {
    GET: async (req: Bun.BunRequest<"/api/claims/:id">) => {
      const id = req.params.id;
      const db = getDb();
      const claim = await db.claims.get(id);
      if (!claim) return notFound();
      return Response.json({
        claim,
        evidence: await db.evidence.get(id),
        appeals: await db.appeals.find({ claim_id: id }),
        transcript: await db.transcript.find({ claim_id: id }),
      });
    },
  },

  "/api/claims/:id/process": {
    POST: async (req: Bun.BunRequest<"/api/claims/:id/process">) => {
      if (!(await getDb().claims.get(req.params.id))) return notFound();
      void processClaimSafe(req.params.id);
      return Response.json({ queued: req.params.id });
    },
  },

  "/api/ledger": { GET: async () => Response.json(await ledgerSummary()) },

  /** Settled recoveries per time bucket (RecoveryPoint[]): the TigerData continuous aggregate, or in-memory buckets. */
  "/api/ledger/series": { GET: async () => Response.json(await recoverySeries()) },

  /** Recent /ws/live history, for debugging without a WebSocket client. */
  "/api/events": { GET: () => Response.json(bus.history()) },
};
