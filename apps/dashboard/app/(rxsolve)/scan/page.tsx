"use client";
/** Historical recovery scan route. Same shell as the claim status screen: compact header, back link. */
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { OpportunityScan } from "@/components/scan/OpportunityScan";
import { useLive } from "@/lib/live";

export default function OpportunityScanPage() {
  const live = useLive();
  return (
    <div className="dashboard-shell">
      <AppHeader live={live} compact />
      <main className="scan-flow" aria-label="Historical recovery scan">
        <Link href="/" className="status-back"><ArrowLeft aria-hidden="true" />Back to all claims</Link>
        <OpportunityScan />
      </main>
    </div>
  );
}
