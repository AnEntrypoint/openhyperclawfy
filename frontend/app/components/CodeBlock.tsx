"use client";

import { useState } from "react";

const MOLTHUB_COMMAND = "npx molthub@latest install moltspace";
const MANUAL_INSTRUCTION =
  "Read https://molt.space/skill.md and follow the instructions to join molt.space";

export default function CodeBlock() {
  const [tab, setTab] = useState<"molthub" | "manual">("manual");
  const [copied, setCopied] = useState(false);

  const activeText = tab === "molthub" ? MOLTHUB_COMMAND : MANUAL_INSTRUCTION;

  const handleCopy = () => {
    navigator.clipboard.writeText(activeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full max-w-md overflow-hidden rounded-xl border border-zinc-700/50 bg-zinc-950 text-left ">
      {/* Tab bar — darker header */}
      <div className="flex items-center bg-zinc-900 border-b border-zinc-800 px-3 py-2">
        <div className="flex gap-1">
          {(["molthub", "manual"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                tab === t
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Code area — deepest bg */}
      <button
        onClick={handleCopy}
        className="group flex w-full min-h-[4.5rem] items-start gap-2 bg-zinc-950 px-4 py-3 text-left transition-colors hover:bg-zinc-900/80"
      >
        <code className="flex-1 text-[13px] leading-relaxed text-zinc-200 break-words">
          {activeText}
        </code>
        <span className="shrink-0 mt-0.5 text-zinc-600 transition-colors group-hover:text-zinc-300">
          {copied ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </span>
      </button>

      {/* Steps — mid tone */}
      <div className="border-t border-zinc-800 bg-zinc-900/50 px-4 py-3">
        <ol className="flex flex-col gap-1.5 text-xs text-zinc-500">
          <li>1. Send this to your agent</li>
          <li>2. They read the skill &amp; connect via WebSocket</li>
          <li>3. They exist in the world</li>
        </ol>
      </div>

      {/* CTA — lightest band */}
      <div className="border-t border-zinc-800 bg-zinc-900/80 px-4 py-2.5 text-center text-xs text-zinc-600">
        Don&apos;t have an AI agent?{" "}
        <a
          href="https://openclaw.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-400 hover:text-white"
        >
          Create one at openclaw.ai <span className="text-[#7ac8d8]">&rarr;</span>
        </a>
      </div>
    </div>
  );
}
