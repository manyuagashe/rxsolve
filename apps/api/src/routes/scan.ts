/** Historical opportunity scan routes. Owner: MasonMines2006 (off-ticket; see docs/STATUS.md). */
import { config } from "../config";
import { scanOpportunityCsv, suggestOpportunityHeaders } from "../opportunity-scan";
import { getPolicy } from "../policy";
import { handoffScanClaims, MAX_HANDOFF_CLAIMS } from "../scan-handoff";

const badRequest = (error: string) => Response.json({ error }, { status: 400 });

export const scanRoutes = {
  /**
   * Analyze historical synthetic/de-identified claims without storing or filing them. A configured
   * model sees unknown column names only; claim values always stay inside deterministic parsing.
   */
  "/api/opportunity-scan": {
    POST: async (req: Request) => {
      try {
        const body = await req.json() as { csv?: unknown; now?: unknown };
        if (typeof body.csv !== "string" || !body.csv.trim()) return badRequest("csv must be a non-empty string");
        if (typeof body.now !== "undefined" && (typeof body.now !== "string" || Number.isNaN(Date.parse(body.now)))) {
          return badRequest("now must be an ISO date-time");
        }
        const result = await scanOpportunityCsv(body.csv, {
          now: typeof body.now === "string" ? new Date(body.now) : undefined,
          suggestHeaders: config.agentApiKey ? suggestOpportunityHeaders : undefined,
        });
        return Response.json(result);
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : "Unable to scan this CSV");
      }
    },
  },

  /** The saved standing authorization, so the scan page can show the limit a handoff runs under. */
  "/api/opportunity-scan/policy": {
    GET: async () => {
      const policy = await getPolicy(config.pharmacyId);
      return Response.json({ auto_file_max: policy.auto_file_max, paused: policy.paused });
    },
  },

  /**
   * Hands selected scan rows to the claim pipeline. Unlike POST /api/opportunity-scan this stores
   * claims and can file appeals, under the pharmacy's saved policy (it never changes the policy).
   * Body: { csv, claim_ids }.
   */
  "/api/opportunity-scan/handoff": {
    POST: async (req: Request) => {
      const body = await req.json().catch(() => null) as { csv?: unknown; claim_ids?: unknown } | null;
      if (!body || typeof body.csv !== "string" || !body.csv.trim()) return badRequest("csv must be a non-empty string");

      const ids = body.claim_ids;
      const validIds = Array.isArray(ids) && ids.length >= 1 && ids.length <= MAX_HANDOFF_CLAIMS
        && ids.every((id) => typeof id === "string" && id.trim() !== "");
      if (!validIds) return badRequest(`claim_ids must list between 1 and ${MAX_HANDOFF_CLAIMS} claim IDs`);

      try {
        return Response.json(await handoffScanClaims({ csv: body.csv, claimIds: ids as string[] }));
      } catch (error) {
        // The scanner throws plain messages for malformed files (missing columns, bad dates).
        return badRequest(error instanceof Error ? error.message : "Unable to hand off these claims");
      }
    },
  },
};
