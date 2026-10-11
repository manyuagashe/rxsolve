"use client";
/** Header theme control (UI-07): Frutiger Aero (daylight DORFic) and Dark Aero. Persists per viewer, no reload. */
import { useEffect, useState } from "react";
import { Moon, Sparkles } from "lucide-react";

const THEMES = [
  { id: "aero", label: "Frutiger Aero", Icon: Sparkles },
  { id: "dark", label: "Dark Aero", Icon: Moon },
] as const;
type Theme = (typeof THEMES)[number]["id"];

const isTheme = (value: string | undefined): value is Theme => THEMES.some((t) => t.id === value);

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>("aero");

  useEffect(() => {
    const active = document.documentElement.dataset.theme;
    if (isTheme(active)) setTheme(active);
  }, []);

  const pick = (next: Theme) => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("rxsolve-theme", next);
    } catch {
      // The in-memory theme still applies when storage is unavailable.
    }
    setTheme(next);
  };

  const current = THEMES.find((t) => t.id === theme)!;
  return (
    <div className="theme-switcher" role="group" aria-label="Color theme">
      {THEMES.map(({ id, label, Icon }) => (
        <button
          key={id}
          className="theme-switcher__option"
          type="button"
          aria-label={`Use ${label} theme`}
          aria-pressed={theme === id}
          onClick={() => pick(id)}
        >
          <Icon aria-hidden="true" />
          {label}
        </button>
      ))}
      <span className="sr-only" aria-live="polite" aria-atomic="true">Theme: {current.label}</span>
    </div>
  );
}
