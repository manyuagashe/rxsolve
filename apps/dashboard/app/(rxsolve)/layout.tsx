import type { Metadata } from "next";
import "../globals.css";
import "../panels.css";

export const metadata: Metadata = { title: "RxSolve", description: "Every claim resolves at or above cost." };

// Applies the saved theme before paint so switching never flashes or reloads.
// Only "aero" and "dark" exist; a saved choice from the retired Light theme falls back to Frutiger Aero.
const themeBoot = `try{var t=localStorage.getItem("rxsolve-theme");document.documentElement.dataset.theme=t==="dark"?"dark":"aero"}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="aero" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
