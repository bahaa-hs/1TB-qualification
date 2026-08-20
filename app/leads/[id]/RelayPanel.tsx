"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Textarea } from "@/components/ui/primitives";
import type { StepResult } from "@/lib/conversation";
import {
  discardDraftAction,
  draftNextAction,
  markSentAction,
  recordReplyAction,
} from "./actions";

interface Draft {
  id: number;
  body: string;
}

/**
 * The manual relay: the AI drafts, you copy it into whatever app the lead uses,
 * you paste their reply back.
 *
 * On a channel the tool can't send through, drafting and sending are genuinely
 * separate acts. Keeping them separate here is what lets the reply-rate stat
 * mean something — a lead only counts as outreached once you say the message
 * actually went.
 */
export function RelayPanel({
  leadId,
  channel,
  stage,
  aiEnabled,
  draft,
  hasSentAnything,
}: {
  leadId: number;
  channel: string;
  stage: string;
  aiEnabled: boolean;
  draft: Draft | null;
  hasSentAnything: boolean;
}) {
  const [pending, start] = useTransition();
  const [reply, setReply] = useState("");
  const [note, setNote] = useState<{ tone: "info" | "warn"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function handle(result: StepResult) {
    setCopied(false);
    if (result.kind === "skipped") setNote({ tone: "warn", text: result.reason });
    else if (result.kind === "blocked") {
      setNote({
        tone: "warn",
        text: `Nothing was drafted — ${result.errors.join(" ")}`,
      });
    } else if (result.kind === "decided") {
      setNote({ tone: "info", text: "The AI has reached a decision. Review it below." });
    } else if (result.kind === "drafted" && result.ungrounded?.length) {
      setNote({
        tone: "warn",
        text: `The model claimed the lead said ${result.ungrounded.join(", ")} and was overruled.`,
      });
    } else setNote(null);
  }

  const run = (fn: () => Promise<StepResult>) => start(async () => handle(await fn()));

  if (!aiEnabled) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-900">You&rsquo;ve taken over</h2>
        <p className="mt-1 text-sm text-neutral-500">
          The AI won&rsquo;t send or read anything on this lead. Hand it back above to resume.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-900">
          {draft ? "Ready to send" : hasSentAnything ? "Their reply" : "Start the conversation"}
        </h2>
        <Badge tone="neutral">{channel}</Badge>
      </div>

      {note && (
        <p
          className={`mt-3 rounded-md border px-3 py-2 text-sm ${
            note.tone === "warn"
              ? "border-amber-200 bg-amber-50 text-amber-900"
              : "border-blue-200 bg-blue-50 text-blue-900"
          }`}
        >
          {note.text}
        </p>
      )}

      {draft ? (
        <>
          <p className="mt-1 text-sm text-neutral-500">
            Copy this into {channel}, then confirm you&rsquo;ve sent it.
          </p>
          <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-neutral-100 p-3 font-sans text-sm text-neutral-800">
            {draft.body}
          </pre>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                navigator.clipboard.writeText(draft.body);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  await markSentAction(leadId, draft.id);
                  setCopied(false);
                  setNote(null);
                })
              }
            >
              {pending ? "…" : "I've sent this"}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  if (!confirm("Discard this draft? The AI can write another.")) return;
                  await discardDraftAction(leadId, draft.id);
                  setNote(null);
                })
              }
            >
              Discard
            </Button>
          </div>
        </>
      ) : !hasSentAnything ? (
        <>
          <p className="mt-1 text-sm text-neutral-500">
            The AI will write an opening message for you to send. It introduces itself as an AI and
            tells the lead they can ask for a person.
          </p>
          <Button className="mt-3" disabled={pending} onClick={() => run(() => draftNextAction(leadId))}>
            {pending ? "Writing…" : "Draft the opening message"}
          </Button>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-neutral-500">
            Paste what they said and the AI will write the next message.
          </p>
          <Textarea
            className="mt-3"
            rows={3}
            value={reply}
            disabled={pending}
            placeholder="Paste their reply…"
            onChange={(e) => setReply(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              disabled={pending || !reply.trim()}
              onClick={() => {
                const text = reply.trim();
                setReply("");
                run(() => recordReplyAction(leadId, text));
              }}
            >
              {pending ? "Thinking…" : "Log reply"}
            </Button>
            {stage === "outreached" && (
              <span className="text-xs text-neutral-400">
                No reply yet? Leave it — it auto-closes after 30 days.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
