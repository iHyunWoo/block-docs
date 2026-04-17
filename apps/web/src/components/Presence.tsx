"use client";

import { useBlockStore } from "@/store/block-store";

export function Presence() {
  const awareness = useBlockStore((s) => s.awareness);
  const entries = Array.from(awareness.values());

  return (
    <div className="presence-container" aria-label="Connected users">
      {entries.map((u) => (
        <span
          key={u.userId}
          className="presence-dot"
          title={u.name}
          style={{ backgroundColor: u.color }}
        >
          <span className="presence-initial">{initials(u.name)}</span>
        </span>
      ))}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
