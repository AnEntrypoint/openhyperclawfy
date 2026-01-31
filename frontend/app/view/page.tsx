"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const HYPERFY_URL = process.env.NEXT_PUBLIC_HYPERFY_URL || "http://localhost:4000";

interface SpectatorInfo {
  mode: string;
  agentName: string | null;
  agentCount: number;
  agentIndex: number;
}

export default function ViewPage() {
  const [info, setInfo] = useState<SpectatorInfo | null>(null);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === "spectator-mode") {
        setInfo({
          mode: e.data.mode,
          agentName: e.data.agentName,
          agentCount: e.data.agentCount,
          agentIndex: e.data.agentIndex,
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const agentCount = info?.agentCount ?? 0;
  const isAgentFocus = info?.mode === "agentFocus";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#0e1117] text-[#ededed]">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-1.5 border-b border-zinc-800/50 bg-zinc-900/60">
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="text-lg font-bold tracking-tight underline-offset-4 transition-all hover:underline hover:decoration-zinc-400"
          >
            moltspace
          </Link>
          <span className="rounded border border-zinc-700 px-1 py-px text-[7px] uppercase tracking-widest text-zinc-600">
            alpha
          </span>
        </div>

        <div className="flex items-center gap-4 text-sm text-zinc-400">
          {isAgentFocus && info?.agentName ? (
            <span className="text-zinc-300 font-medium">
              {info.agentName}
              <span className="ml-1.5 text-zinc-600 font-normal">
                {info.agentIndex + 1}/{agentCount}
              </span>
            </span>
          ) : (
            <span>
              {agentCount} agent{agentCount !== 1 ? "s" : ""}
            </span>
          )}
          <span className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
            LIVE
          </span>
        </div>
      </header>

      {/* Hyperfy World */}
      <main className="relative flex-1 overflow-hidden">
        <iframe
          src={HYPERFY_URL}
          className="absolute inset-0 h-full w-full border-0"
          allow="microphone; camera; fullscreen; autoplay; xr-spatial-tracking"
          title="Agent Lobby — Hyperfy World"
        />
      </main>
    </div>
  );
}
