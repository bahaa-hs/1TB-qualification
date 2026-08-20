"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/primitives";
import { disableAllAiAction } from "./actions";

/**
 * Global kill switch. Sets ai_enabled = 0 on every lead, so no queued turn can
 * send. Deliberately in the header rather than in Settings — with autonomous
 * sending on, "stop everything" has to be reachable without thinking.
 */
export function StopAllButton() {
  const [pending, start] = useTransition();
  const [stopped, setStopped] = useState<number | null>(null);

  return (
    <div className="flex items-center gap-2">
      {stopped !== null && (
        <span className="text-xs text-neutral-500">
          {stopped === 0 ? "nothing was running" : `stopped ${stopped}`}
        </span>
      )}
      <Button
        variant="danger"
        disabled={pending}
        onClick={() =>
          start(async () => {
            if (!confirm("Stop the AI on every lead? You can re-enable them individually.")) return;
            setStopped(await disableAllAiAction());
          })
        }
      >
        {pending ? "Stopping…" : "Stop all AI"}
      </Button>
    </div>
  );
}
