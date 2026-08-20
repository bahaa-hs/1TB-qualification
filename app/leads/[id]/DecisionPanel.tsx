"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Textarea } from "@/components/ui/primitives";
import { reviewDecisionAction } from "./actions";

/**
 * Stage 4. The AI's verdict, and the one click that produces the accuracy stat.
 *
 * Agreeing or disagreeing is the only source of ground truth in the whole
 * system — without it the accuracy rate has nothing to compute from. That's why
 * it's the primary action here rather than something tucked away.
 */
export function DecisionPanel({
  leadId,
  verdict,
  summary,
  collected,
  review,
}: {
  leadId: number;
  verdict: "qualified" | "rejected";
  summary: string;
  collected: [string, string][];
  review: { humanVerdict: string; agreed: boolean; note: string | null; reviewedAt: string } | null;
}) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);

  const qualified = verdict === "qualified";

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">The AI&rsquo;s call</h2>
        <Badge tone={qualified ? "green" : "red"}>
          {qualified ? "Worth a human" : "Reject"}
        </Badge>
      </div>

      <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-800">{summary}</p>

      {collected.length > 0 && (
        <dl className="mt-4 space-y-1.5 border-t border-neutral-100 pt-3 text-sm">
          {collected.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[130px_minmax(0,1fr)] gap-2">
              <dt className="truncate text-neutral-400">{k}</dt>
              <dd className="break-words text-neutral-800">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {review ? (
        <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
          <span className="font-medium text-neutral-800">
            You {review.agreed ? "agreed" : "disagreed"}
          </span>
          <span className="text-neutral-500">
            {" "}
            — marked {review.humanVerdict === "qualified" ? "worth a human" : "rejected"} on{" "}
            {review.reviewedAt}.
          </span>
          {review.note && <p className="mt-1 text-neutral-600">{review.note}</p>}
        </div>
      ) : (
        <div className="mt-4 border-t border-neutral-100 pt-3">
          <p className="text-xs text-neutral-500">
            Read the conversation, then say whether the AI got it right. This is what the accuracy
            rate is measured from.
          </p>
          {showNote && (
            <Textarea
              className="mt-2"
              rows={2}
              value={note}
              placeholder="Why? (optional)"
              onChange={(e) => setNote(e.target.value)}
            />
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              disabled={pending}
              onClick={() => start(() => reviewDecisionAction(leadId, verdict, note))}
            >
              {pending ? "…" : "Agree"}
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() =>
                start(() =>
                  reviewDecisionAction(leadId, qualified ? "rejected" : "qualified", note),
                )
              }
            >
              Disagree — {qualified ? "reject instead" : "worth a human"}
            </Button>
            {!showNote && (
              <button
                type="button"
                className="text-xs text-neutral-500 hover:text-neutral-900"
                onClick={() => setShowNote(true)}
              >
                Add a note
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
