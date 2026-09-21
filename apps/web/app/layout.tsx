import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/nav";
import { LiveRefresh } from "@/components/live-refresh";
import { navCounts, workerOnline } from "@/lib/server";

export const metadata: Metadata = {
  title: "Prowl",
  description: "Find matching jobs, tailor truthful applications, and track every submission.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const counts = navCounts();
  const worker = workerOnline();
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-56 shrink-0 border-r border-border bg-panel md:block">
            <Nav counts={counts} worker={worker} />
          </aside>
          <main className="min-w-0 flex-1">
            <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-8 md:py-8">{children}</div>
          </main>
        </div>
        <LiveRefresh />
      </body>
    </html>
  );
}
