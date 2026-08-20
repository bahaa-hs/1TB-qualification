import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { startPollLoop } from "@/lib/worker";
import { StopAllButton } from "./StopAllButton";

export const metadata: Metadata = {
  title: "Outreach AI",
  description: "Local lead qualification pipeline",
};

const NAV = [
  { href: "/", label: "Pipeline" },
  { href: "/import", label: "Import" },
  { href: "/brain", label: "Brain" },
  { href: "/stats", label: "Stats" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Boot the scheduler. Idempotent, and the layout is a server component so
  // this only ever runs in the Node runtime — see the note on startPollLoop.
  startPollLoop();

  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-neutral-200 bg-white">
          <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
            <span className="text-sm font-semibold tracking-tight">Outreach&nbsp;AI</span>
            <nav className="flex gap-1">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="rounded-md px-2.5 py-1 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            {/* Autonomous sending is on, so the panic button is always one click
                away rather than buried in settings. */}
            <div className="ml-auto">
              <StopAllButton />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
