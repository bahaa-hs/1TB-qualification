import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Collapsible } from "@/components/ui/primitives";
import { STAGE_LABELS, TERMINAL_STAGES } from "@/lib/db";
import {
  getLead,
  getReview,
  leadCollected,
  leadWarnings,
  listMessages,
  pendingDraft,
} from "@/lib/leads";
import { relayChannel } from "@/lib/conversation";
import { establishedFacts } from "@/lib/criteria";
import { listCriteria } from "@/lib/criteriaStore";
import { ContactPanel } from "./ContactPanel";
import { AiToggle } from "./AiToggle";
import { RelayPanel } from "./RelayPanel";
import { DecisionPanel } from "./DecisionPanel";

export const dynamic = "force-dynamic";

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lead = getLead(Number(id));
  if (!lead) notFound();

  const warnings = leadWarnings(lead);
  const messages = listMessages(lead.id);
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim();
  const rawRow = JSON.parse(lead.raw_row) as Record<string, string>;

  const draft = pendingDraft(lead.id);
  const hasSentAnything = messages.some((m) => m.sent_at);
  const isTerminal = TERMINAL_STAGES.includes(lead.stage);
  const review = getReview(lead.id);

  // Label the collected facts from the glossary, so the reviewer reads
  // "Use case — Web scraping" rather than "use_case — web_scraping".
  //
  // This reads the criteria registry rather than the playbook's questions,
  // because a fact worked out by an analysis block was never anyone's question.
  // Keys with no criterion are kept and grouped separately: a value collected
  // before someone renamed a criterion is still the evidence the verdict was
  // based on.
  const facts = establishedFacts(listCriteria(), leadCollected(lead));
  const collected = facts
    .filter((f) => f.known)
    .map((f) => [f.label, f.display] as [string, string]);
  const untracked = facts.filter((f) => !f.known);

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-900">
        ← Pipeline
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">
          {name || lead.email || lead.submission_id}
        </h1>
        <Badge tone="blue">{STAGE_LABELS[lead.stage]}</Badge>
        {lead.ai_enabled === 0 && <Badge tone="gray">AI off</Badge>}
        <div className="ml-auto">
          <AiToggle leadId={lead.id} enabled={lead.ai_enabled === 1} />
        </div>
      </div>

      {warnings.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          {warnings.map((w) => (
            <li key={w} className="text-sm text-amber-900">
              {w}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-4">
          {lead.verdict && (
            <DecisionPanel
              leadId={lead.id}
              verdict={lead.verdict as "qualified" | "rejected"}
              summary={lead.verdict_summary ?? ""}
              collected={[
                ...collected,
                // Kept rather than dropped — see above. Marked so a reviewer
                // can tell a live criterion from a leftover one.
                ...untracked.map((f) => [`${f.label} (no longer tracked)`, f.display] as [string, string]),
              ]}
              review={
                review
                  ? {
                      humanVerdict: review.human_verdict,
                      agreed: review.agreed === 1,
                      note: review.note,
                      reviewedAt: review.reviewed_at,
                    }
                  : null
              }
            />
          )}

          {/* Once the AI has a verdict it has nothing left to ask, so stop
              inviting replies — unless a final message is still waiting to be
              relayed, in which case the send controls are still needed. */}
          {!isTerminal && (!lead.verdict || draft) && (
            <RelayPanel
              leadId={lead.id}
              channel={relayChannel(lead)}
              stage={lead.stage}
              aiEnabled={lead.ai_enabled === 1}
              draft={draft ? { id: draft.id, body: draft.body ?? "" } : null}
              hasSentAnything={hasSentAnything}
            />
          )}

          {lead.last_error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {lead.last_error}
            </p>
          )}

          <div>
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Conversation</h2>
            {messages.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center text-sm text-neutral-400">
                Nothing yet. Outreach and the AI conversation land here.
              </div>
            ) : (
              <ol className="space-y-2">
                {messages.map((m) => (
                  <li
                    key={m.id}
                    className={`rounded-lg border p-3 ${
                      m.direction === "inbound"
                        ? "border-neutral-200 bg-white"
                        : m.sent_at
                          ? "border-neutral-200 bg-neutral-100"
                          : "border-dashed border-amber-300 bg-amber-50"
                    }`}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
                      <span className="font-medium text-neutral-600">
                        {m.direction === "inbound"
                          ? name || "Lead"
                          : m.sent_by === "ai"
                            ? "AI"
                            : "You"}
                      </span>
                      <span>·</span>
                      <span>{m.channel}</span>
                      <span>·</span>
                      <time>{m.sent_at ?? m.created_at}</time>
                      {m.direction === "outbound" && !m.sent_at && (
                        <Badge tone="amber">not sent yet</Badge>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-neutral-800">{m.body}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <ContactPanel
            leadId={lead.id}
            initial={{
              email: lead.email ?? "",
              whatsappE164: lead.whatsapp_e164 ?? "",
              telegramHandle: lead.telegram_handle ?? "",
              linkedinUrl: lead.linkedin_url ?? "",
              companyWebsite: lead.company_website ?? "",
              preferredChannel: lead.preferred_channel ?? "",
            }}
            whatsappRaw={lead.whatsapp_raw}
            editedBy={lead.contact_edited_by}
            editedAt={lead.contact_edited_at}
          />

          <div className="rounded-lg border border-neutral-200 bg-white p-3">
            <h3 className="mb-2 text-xs font-medium text-neutral-500">Application</h3>
            <dl className="space-y-1.5 text-sm">
              <Row label="Volume" value={lead.expected_volume} />
              <Row label="Submitted" value={rawRow["Submission started"]} />
              <Row label="Submission" value={lead.submission_id} mono />
            </dl>
          </div>

          <Collapsible summary="Original CSV row">
            <dl className="space-y-1 text-xs">
              {Object.entries(rawRow)
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[110px_minmax(0,1fr)] gap-2">
                    <dt className="truncate text-neutral-400">{k}</dt>
                    <dd className="break-words text-neutral-700">{v}</dd>
                  </div>
                ))}
            </dl>
          </Collapsible>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-2">
      <dt className="text-neutral-400">{label}</dt>
      <dd className={`break-words text-neutral-800 ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
