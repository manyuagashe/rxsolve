"use client";
/** Per-node "Artifacts" disclosure: each file a step produced, opened inside the page. Owner: P3. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fitPopover } from "./popover";
import { type ArtifactItem, type ArtifactKind, artifactUrl, limitText } from "@/lib/artifacts";

type Loaded =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "ok"; text?: string; truncated?: boolean; objectUrl?: string };

function useArtifact(name: string, kind: ArtifactKind): Loaded {
  const [got, setGot] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let dead = false;
    let made: string | null = null;
    setGot({ state: "loading" });
    (async () => {
      try {
        const r = await fetch(artifactUrl(name));
        if (!r.ok) throw new Error(String(r.status));
        if (kind === "html" || kind === "txt") {
          const { text, truncated } = limitText(await r.text());
          if (!dead) setGot({ state: "ok", text, truncated });
        } else {
          made = URL.createObjectURL(await r.blob());
          if (!dead) setGot({ state: "ok", objectUrl: made });
        }
      } catch {
        if (!dead) setGot({ state: "missing" });
      }
    })();
    return () => {
      dead = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [name, kind]);
  return got;
}

function FileItem({ item }: { item: Extract<ArtifactItem, { type: "file" }> }) {
  const got = useArtifact(item.name, item.kind);
  const href = artifactUrl(item.name);
  return (
    <li className="artifact">
      <p className="artifact__label">
        <strong>{item.label}</strong><span className="sr-only"> ({item.name})</span>
      </p>
      {item.caption && <p className="caption">{item.caption}</p>}
      {got.state === "loading" && <p className="caption" role="status">Loading...</p>}
      {got.state === "missing" && <p className="artifact__missing" role="status">artifact not available</p>}
      {got.state === "ok" && item.kind === "html" && (
        <iframe className="artifact__frame" sandbox="" srcDoc={got.text} title={`${item.label} (${item.name})`} />
      )}
      {got.state === "ok" && item.kind === "png" && got.objectUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="artifact__img" src={got.objectUrl} alt={`${item.label}: ${item.name}`} />
      )}
      {got.state === "ok" && item.kind === "pdf" && got.objectUrl && (
        <embed className="artifact__frame" src={got.objectUrl} type="application/pdf" title={`${item.label} (${item.name})`} />
      )}
      {got.state === "ok" && item.kind === "txt" && (
        <>
          <pre className="artifact__pre" tabIndex={0}>{got.text}</pre>
          {got.truncated && <p className="caption">Shortened for display.</p>}
        </>
      )}
      {got.state === "ok" && (
        <a className="artifact__open" href={href} target="_blank" rel="noreferrer">
          Open in new tab<span className="sr-only"> ({item.name})</span>
        </a>
      )}
    </li>
  );
}

function ArtifactBody({ item }: { item: ArtifactItem }) {
  if (item.type === "file") return <FileItem item={item} />;
  if (item.type === "text") {
    return (
      <li className="artifact">
        <p className="artifact__label"><strong>{item.label}</strong></p>
        <pre className="artifact__pre" tabIndex={0}>{item.text}</pre>
      </li>
    );
  }
  return (
    <li className="artifact">
      <p className="artifact__label"><strong>{item.label}</strong></p>
      <table className="artifact__table">
        <tbody>
          {Object.entries(item.fields).map(([k, v]) => (
            <tr key={k}><th scope="row">{k.replaceAll("_", " ")}</th><td>{v}</td></tr>
          ))}
        </tbody>
      </table>
    </li>
  );
}

type Pos = { left: number; maxHeight: number; top?: number; bottom?: number };

/** Anchors a fixed-position popup to `anchor`, flipping above when there is no room below. */
function useFloatingPos(on: boolean, anchor: React.RefObject<HTMLElement | null>): Pos | null {
  const [pos, setPos] = useState<Pos | null>(null);
  useLayoutEffect(() => {
    if (!on) { setPos(null); return; }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      const w = Math.min(440, window.innerWidth * 0.7);
      const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
      const below = window.innerHeight - a.bottom - 12;
      const above = a.top - 12;
      const up = below < 260 && above > below;
      const maxHeight = Math.max(160, Math.min(window.innerHeight * 0.7, up ? above : below));
      setPos(up ? { left, bottom: window.innerHeight - a.top + 4, maxHeight } : { left, top: a.bottom + 4, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [on, anchor]);
  return pos;
}

/**
 * Content mounts only once opened, so closed drawers fetch nothing. Inside the horizontal tree on wide screens
 * the list is portalled to the body so the tree's scroll box cannot clip it.
 */
export function ArtifactsDrawer({ items }: { items: ArtifactItem[] }) {
  const [open, setOpen] = useState(false);
  const [float, setFloat] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const summary = useRef<HTMLElement>(null);
  const pos = useFloatingPos(open && float, summary);
  useEffect(() => {
    if (open && !float) requestAnimationFrame(() => fitPopover(list.current));
  }, [open, float, items.length]);
  if (items.length === 0) return null;
  const body = items.map((it, i) => <ArtifactBody key={`${it.type}-${i}`} item={it} />);
  return (
    <details
      className="artifacts"
      onToggle={(e) => {
        const d = e.currentTarget;
        d.closest(".tnode__card")?.classList.toggle("tnode__card--open", d.open);
        setFloat(d.open && !!d.closest(".tree-scroll") && window.matchMedia("(min-width: 900px)").matches);
        setOpen(d.open);
      }}
    >
      <summary ref={summary}>Artifacts ({items.length})</summary>
      {open && !float && <ul className="plain artifacts__list" ref={list}>{body}</ul>}
      {open && float && pos && createPortal(
        <ul className="plain artifacts__pop" style={pos}>{body}</ul>,
        document.body,
      )}
    </details>
  );
}
