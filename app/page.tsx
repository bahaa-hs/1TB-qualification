import Link from "next/link";
import { Badge } from "@/components/ui/primitives";
import { STAGE_LABELS, type LeadRow, type Stage } from "@/lib/db";
import { leadCollected, leadWarnings, listLeads } from "@/lib/leads";
import { establishedFacts, type CriteriaRegistry } from "@/lib/criteria";
import { listCriteria } from "@/lib/criteriaStore";

export const dynamic = "force-dynamic";

/** The four stages from the spec, plus one closed column for terminal leads. */
const COLUMNS: { stage: Stage; blurb: string }[] = [
  { stage: "fresh", blurb: "Not yet contacted" },
  { stage: "outreached", blurb: "Waiting for a reply" },
  { stage: "replied", blurb: "AI is qualifying" },
  { stage: "decision", blurb: "Needs your review" },
];

const CLOSED: Stage[] = ["handed_off", "rejected", "disqualified"];

const CHANNEL_TONE: Record<string, "blue" | "green" | "amber" | "neutral"> = {
  email: "neutral",
  linkedin: "blue",
  whatsapp: "green",
  telegram: "amber",
};

function displayName(lead: LeadRow): string {
  const n = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim();
  return n || lead.email || lead.submission_id;
}

/**
 * "due in 3 days" / "overdue" for a lead sitting in a wait.
 *
 * SQLite stores these as UTC "YYYY-MM-DD HH:MM:SS"; the T and Z make Date parse
 * it as UTC rather than local, which would otherwise shift everything by the
 * timezone offset and quietly mislabel things as overdue.
 */
function dueLabel(next: string | null): { label: string; overdue: boolean } | null {
  if (!next) return null;
  const at = new Date(`${next.replace(" ", "T")}Z`).getTime();
  if (Number.isNaN(at)) return null;
  const mins = Math.round((at - Date.now()) / 60000);
  if (mins <= 0) return { label: "due now", overdue: true };
  if (mins < 60) return { label: `due in ${mins}m`, overdue: false };
  if (mins < 60 * 24) return { label: `due in ${Math.round(mins / 60)}h`, overdue: false };
  return { label: `due in ${Math.round(mins / (60 * 24))}d`, overdue: false };
}

function LeadCard({ lead, criteria }: { lead: LeadRow; criteria: CriteriaRegistry }) {
  const warnings = leadWarnings(lead);
  const due = dueLabel(lead.next_due_at);
  // What the AI has established, in the glossary's words. This is what keeps
  // the board and the workflow talking about the same things.
  const established = establishedFacts(criteria, leadCollected(lead)).filter((f) => f.showOnBoard);
  return (
    <Link
      href={`/leads/${lead.id}`}
      className="block rounded-lg border border-neutral-200 bg-white p-3 transition-colors hover:border-neutral-400"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-sm font-medium text-neutral-900">{displayName(lead)}</span>
        {lead.ai_enabled === 0 && <Badge tone="gray">AI off</Badge>}
      </div>
      {lead.email && (
        <div className="mt-0.5 truncate text-xs text-neutral-500">{lead.email}</div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {lead.preferred_channel && (
          <Badge tone={CHANNEL_TONE[lead.preferred_channel] ?? "neutral"}>
            {lead.preferred_channel}
          </Badge>
        )}
        {lead.expected_volume && <Badge tone="neutral">{lead.expected_volume}</Badge>}
        {established.map((f) => (
          <Badge key={f.key} tone="blue">
            {f.display}
          </Badge>
        ))}
        {warnings.length > 0 && <Badge tone="red">needs fixing</Badge>}
        {/* The scheduler only ticks while the app is open, so a wait that has
            already elapsed needs to be visible rather than silently late. */}
        {due && <Badge tone={due.overdue ? "amber" : "gray"}>{due.label}</Badge>}
      </div>
    </Link>
  );
}

function Column({
  title,
  blurb,
  leads,
  criteria,
}: {
  title: string;
  blurb: string;
  leads: LeadRow[];
  criteria: CriteriaRegistry;
}) {
  return (
    <section className="flex min-w-0 flex-col">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
        <span className="text-xs text-neutral-400">{leads.length}</span>
      </div>
      <p className="mb-3 text-xs text-neutral-400">{blurb}</p>
      {/* Each column scrolls on its own. With a real import the Fresh column
          runs to dozens of cards, and letting it stretch the page means the
          other three stages are permanently below the fold. */}
      <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto pr-1">
        {leads.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-200 p-4 text-center text-xs text-neutral-400">
            Empty
          </div>
        ) : (
          leads.map((l) => <LeadCard key={l.id} lead={l} criteria={criteria} />)
        )}
      </div>
    </section>
  );
}

export default function PipelinePage() {
  const leads = listLeads();
  const criteria = listCriteria();
  const byStage = (s: Stage) => leads.filter((l) => l.stage === s);
  const closed = leads.filter((l) => CLOSED.includes(l.stage));

  if (leads.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-12 text-center">
        <h1 className="text-base font-semibold text-neutral-900">No leads yet</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
          Upload a Fillout CSV export to get started. Re-uploading the same file later is safe —
          leads are matched on their Submission ID.
        </p>
        <Link
          href="/import"
          className="mt-4 inline-block rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Import a CSV
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="mb-5 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Pipeline</h1>
        <span className="text-xs text-neutral-500">{leads.length} leads</span>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((c) => (
          <Column
            key={c.stage}
            title={STAGE_LABELS[c.stage]}
            blurb={c.blurb}
            leads={byStage(c.stage)}
            criteria={criteria}
          />
        ))}
      </div>

      {closed.length > 0 && (
        <section className="mt-10 border-t border-neutral-200 pt-6">
          <h2 className="mb-3 text-sm font-semibold text-neutral-900">
            Closed <span className="ml-1 text-xs font-normal text-neutral-400">{closed.length}</span>
          </h2>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
            {closed.map((l) => (
              <Link
                key={l.id}
                href={`/leads/${l.id}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 transition-colors hover:border-neutral-400"
              >
                <span className="truncate text-sm text-neutral-600">{displayName(l)}</span>
                <Badge tone={l.stage === "handed_off" ? "green" : "gray"}>
                  {STAGE_LABELS[l.stage]}
                </Badge>
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
