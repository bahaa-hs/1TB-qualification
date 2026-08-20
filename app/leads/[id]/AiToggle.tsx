"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/primitives";
import { setAiEnabledAction } from "@/app/actions";

/**
 * Per-lead human takeover. Turning the AI off is what "a human takes over and
 * the AI stops sending or receiving" means in practice — claimStage() checks
 * this flag inside its compare-and-set, so even a turn already queued loses.
 */
export function AiToggle({ leadId, enabled }: { leadId: number; enabled: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant={enabled ? "danger" : "secondary"}
      disabled={pending}
      onClick={() => start(() => setAiEnabledAction(leadId, !enabled))}
    >
      {pending ? "…" : enabled ? "Take over from AI" : "Hand back to AI"}
    </Button>
  );
}
