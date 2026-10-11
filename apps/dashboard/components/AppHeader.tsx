import Link from "next/link";
import { Check } from "lucide-react";
import { Hero } from "@/components/Hero";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { Pill } from "@/components/ui/Pill";
import type { PanelProps } from "@/components/panels/types";

/** Brand, live stream status and theme switcher; the recovered-to-date hero sits below unless `compact`. */
export function AppHeader({ live, compact = false }: PanelProps & { compact?: boolean }) {
  return (
    <header className={`app-header${compact ? " app-header--compact" : ""}`}>
      <div className="app-header__top">
        <Link href="/" className="brand" aria-label="RxSolve home">
          <span className="hex-orb hex-orb--info hex-orb--lg brand__logo" aria-hidden="true"><Check /></span>
          <span>
            <span className="brand__name">RxSolve</span>
            <span className="brand__sub">Meadowbrook Pharmacy</span>
          </span>
        </Link>
        <div className="app-header__controls">
          <Link className="btn btn--ghost btn--sm" href="/scan">Scan historical claims</Link>
          <p className="live-status" role="status" aria-live="polite">
            <Pill tone={live.connected ? "good" : "info"}>{live.connected ? "Live stream connected" : "Connecting to live stream"}</Pill>
          </p>
          <ThemeSwitcher />
        </div>
      </div>
      {!compact && <Hero live={live} />}
    </header>
  );
}
