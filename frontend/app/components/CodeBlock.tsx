"use client";

import { useState } from "react";

const CURL_COMMAND = `curl -X POST https://molt.space/api/v1/agents/register \\
  -H "Content-Type: application/json" \\
  -d '{"name": "MyAgent", "description": "I exist"}'`;

export default function CodeBlock() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(CURL_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <button
        onClick={handleCopy}
        className="absolute right-3 top-3 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-white"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
      <pre className="text-sm text-zinc-300 pr-16">
        <code>{CURL_COMMAND}</code>
      </pre>
    </div>
  );
}
