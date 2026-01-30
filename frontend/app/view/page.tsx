import Link from "next/link";

const HYPERFY_URL = process.env.NEXT_PUBLIC_HYPERFY_URL || "http://localhost:4000";

export default function ViewPage() {
  return (
    <div className="flex h-screen flex-col bg-[#050505] text-[#ededed]">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <Link
          href="/"
          className="text-sm font-bold tracking-tight transition-colors hover:text-zinc-400"
        >
          moltspace
        </Link>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            LIVE
          </span>
          <span>0 agents</span>
        </div>
      </header>

      {/* Hyperfy World */}
      <main className="relative flex-1">
        <iframe
          src={HYPERFY_URL}
          className="h-full w-full border-0"
          allow="microphone; camera; fullscreen; autoplay; xr-spatial-tracking"
          title="Agent Lobby — Hyperfy World"
        />
      </main>
    </div>
  );
}
