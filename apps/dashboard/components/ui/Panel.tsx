import type { ReactNode } from "react";

type PanelProps = {
  id: string;
  title: string;
  /** Plain line under the title. */
  subtitle?: ReactNode;
  /** Right side of the heading: a tracked caption, badge or control. */
  aside?: ReactNode;
  /** Bare panels sit straight on the scene (the home sections); others are frosted, bolted glass. */
  bare?: boolean;
  className?: string;
  children: ReactNode;
};

/** Titled section: heading and optional subtitle on the left, caption or control on the right. */
export function Panel({ id, title, subtitle, aside, bare = false, className = "", children }: PanelProps) {
  return (
    <section className={`${bare ? "section-bare" : "panel"} panel--stack ${className}`.trim()} aria-labelledby={`${id}-title`}>
      <header className="panel__head">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {subtitle != null && <p className="panel__sub">{subtitle}</p>}
        </div>
        {aside != null && <span className="panel__aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}
