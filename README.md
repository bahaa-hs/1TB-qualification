# Outreach AI

Local lead qualification. Import the Fillout CSV, reach out on email and LinkedIn, let an AI
character run the qualification conversation when a lead replies, and work the result as a
four-stage pipeline.

**Everything runs on your own machine.** Your own copy, your own mailbox, your own AI model, your
own database. Nothing is hosted and nothing is shared between teammates, so lead conversations never
leave your laptop.

## Getting started

You need [Node.js](https://nodejs.org) 24 or newer. Then:

**Windows:** double-click **Start Outreach AI.bat**. It installs what's needed, builds, opens your
browser, and keeps running until you close the window.

**Anything else:**

```bash
npm install && npm run build && npm start
```

The app opens at <http://127.0.0.1:3000>. It binds to localhost only — nothing on your network can
reach it, which is also why there's no password to set.

## The pipeline

| Stage | What it means |
| --- | --- |
| **Fresh applications** | Imported, not yet contacted |
| **Outreached** | Contacted, waiting for a reply. Auto-disqualified after 30 days of silence |
| **Replied** | The AI is running the qualification conversation |
| **Decision** | The AI has a verdict and a summary; you agree or disagree |

Leaving the pipeline: **Handed to human**, **Rejected**, or **Disqualified**. Reaching any of them
revokes the tool's access to that lead's conversations for good.

## Channels

| Channel | First touch | Replies |
| --- | --- | --- |
| Email | Automatic | Polled every 60s |
| LinkedIn | Automatic, via HeyReach | Polled |
| Telegram | You send them the bot link | Automatic once they tap it |
| WhatsApp, anything else | You message them | Paste their reply in; the AI drafts the next one |

### Working a lead by hand

Open a lead and the AI writes the opening message. Copy it, send it wherever the lead lives, then
click **I've sent this**. Paste their reply and the AI writes the next one. Repeat until it reaches
a verdict.

Drafting and sending are separate on purpose. On a channel the tool can't send through, only you
know whether the message actually went — and the reply-rate stat is meaningless if "outreached"
means "the AI wrote something". A drafted message shows in the transcript with a **not sent yet**
badge until you confirm it, and you can discard it and have the AI try again.

**Take over from AI** stops it both sending and receiving on that lead. A reply you paste afterwards
is still recorded for you to read; the AI just isn't consulted.

WhatsApp and Telegram both require the lead to message first — Meta needs a pre-approved template
for any business-initiated message, and a Telegram bot simply cannot DM someone who hasn't started
it. Hence the manual first touch on those two.

## The brain

A **workflow** is a graph of steps: reach out, wait, chase again, qualify, decide. The shipped one
opens on the lead's preferred channel, follows up after 3 days and again after 5, and gives up —
while any reply at any point drops straight into qualification.

| Step | What it does |
| --- | --- |
| **Outreach** | Writes and sends a message. Always AI-written; a per-step *brief* is what makes a follow-up sound like a follow-up |
| **Delay** | Waits. Any step can also carry its own "wait 3 days, then…" |
| **Qualify** | The questions below. Its own turn limit, so a first pass and a second pass can differ |
| **Decision** | Qualified, Unqualified, or Never replied |

**Never replied** is a separate outcome on purpose, and it skips the Decision column entirely —
there's no AI verdict to agree or disagree with, and routing it through review would put leads the
AI never spoke to into the accuracy stat.

A workflow won't save unless **every step can reach an outcome**. That one rule covers dead ends,
orphaned branches and loops with no exit — a lead stranded on a step with nowhere to go is invisible
until someone happens to notice it sitting there. When a save is refused, the steps at fault are
outlined on the canvas, and the outlines clear as you fix them.

**You edit it on a canvas.** Add a card with the buttons above it, drag cards where you want them
(positions are saved with the workflow), and click one to open its settings on the right. To connect
a branch, either drag from a coloured dot on a card to the card it should lead to, or use the
**Where it goes next** dropdowns in the side panel — those also show, in words, where a card
currently leads, and are how you disconnect a branch. Each branch leads to exactly one step, so
connecting again moves it rather than adding a second.

**Questions** live inside a qualify step, asked in order, one per message. Any question can carry a
condition — *"only ask this if `use_case` is `web_scraping`"* — which is how branching within the
conversation works. Give a question a list of allowed answers and the AI must pick one or record
nothing.

**Characters** are the voice: a name, how they write, a sign-off, a word limit, whether emoji are
allowed, and **which model they run on**. Stats are tracked per character. What they may and may not
say is in Rules & knowledge below, not on the character.

**Models** are set up in Settings as named connections — "Local 8B", "Claude", whatever — and each
character points at one, falling back to the default if it doesn't. So a small local model can
handle routine leads while something stronger takes the character working your best ones, without
re-entering an API key per character. Changing a model is one edit, not one per character; deleting
a connection drops its characters back to the default rather than leaving them pointing at nothing.

**Rules & knowledge** is the general instruction layer that governs every character — identity,
product knowledge, ground rules, first-message-only instructions, and a never-say list. None of it
is in the code; it's text you edit, and the tab shows a **live preview of the exact prompt** with
your text and the automatic parts labelled separately.

The automatic parts are the character's voice, the lead's details, what's been established, the
question for this turn, the word and emoji limits, and the instruction to answer as JSON. They're
derived from data you control elsewhere, and the preview shows them so the whole prompt is visible
rather than just the half you type.

Ordering is fixed and deliberate: your instructions are interleaved, not appended, so an instruction
can't land below the thing it's meant to govern. That was a real bug — a hardcoded "you must say
you're an AI" line sat under the character's persona and silently beat it, and no amount of editing
the Voice field could turn it off.

**Never say** takes one phrase per line and rejects any reply containing one, retrying and then
blocking rather than sending. Plain case-insensitive substrings, not regexes, so a stray bracket
can't reject everything or silently match nothing. This is how you enforce something like "never
call yourself an AI" — prompting alone provably doesn't hold on a small local model.

If you do remove the AI disclosure: EU AI Act Article 50 has required telling people they're talking
to an AI since 2 August 2026, and Meta's WhatsApp business policy requires it too. Your call, but
worth making deliberately.

A lead who *asks* for a person still gets handed off regardless. That's detected in code from what
they wrote — not stonewalling someone who asks is separate from whether the AI advertises the option.

**Share the brain** with Export / Import. Everyone has their own database, so this is how one person
authors the qualification flow and the team gets it. Importing replaces by name, so an updated
export updates in place.

**Test conversation** runs the whole thing against your model with you playing the lead. Use it
before pointing a new model at anyone real — replies send automatically, so the first live message
is also the first one you can't take back.

### What stops a bad message going out

The app decides what to ask; the model only phrases it. It never picks the next question and never
decides the conversation is over. On top of that, every generation is checked before it is sent, and
anything that fails is retried once with the specific complaint, then blocked:

- empty, over the character's word limit, or using emoji when the character shouldn't
- unfilled `{{placeholders}}`, "as an AI language model", assistant preambles
- schema tokens leaking into the message body (a real one: `LeadIntent: human_requested`)
- an answer outside a question's allowed list, or a field the playbook doesn't have
- calling itself an AI or offering a handover, when the character is set not to disclose

Facts are also **grounded**: a free-text answer is only recorded if it actually appears in what the
lead wrote. Small models otherwise mine the application-form context and report it as something the
lead just said. Discarded facts are shown in the test panel — a model doing it constantly is one to
replace.

"Reply HUMAN" is detected in code rather than left to the model, and a lead who just answered a
question is treated as engaged regardless of how the model classified them.

## Importing

Upload a Fillout CSV export. Leads are matched on Submission ID, so re-uploading the same file
updates rather than duplicates.

Two things the importer is careful about:

- **Phone numbers destroyed by the spreadsheet export.** A value like `9.23188E+11` has genuinely
  lost its digits — no code can recover them. The lead is flagged rather than dialled, and you fix
  it on the lead page.
- **Contact details you've corrected by hand are never overwritten** by a later import.

Every contact field is editable at any time from the lead page.

## Privacy

- The tool can only read conversations it has explicitly bound to a lead from your CSV. Everything
  inbound passes through one allowlist check (`activeThreadLead` in `lib/leads.ts`); anything not on
  the list is dropped before a message body is ever fetched.
- Reaching a terminal stage revokes those threads permanently, and message bodies are purged after a
  retention window.
- Taking over from the AI stops it sending or receiving on that lead immediately, even mid-turn.
- `data/outreach.db` holds your OAuth token and every transcript. It's gitignored, it's per-person,
  and it's the one file worth backing up.

⚠️ Choosing a hosted model (OpenAI, Claude) in Settings means transcript text goes to that vendor.
Ollama keeps it on your machine.

## Development

```bash
npm run dev        # http://127.0.0.1:3000, hot reload
npm run dev:alt    # …on 3001, so it can run beside a real copy on 3000
npm run worker     # the scheduler on its own, if you want its logs separate
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

Two env vars help when working on this while a real copy is running:
`OUTREACH_DB_PATH=data/test.db` for an isolated database, and
`OUTREACH_DIST_DIR=.next-verify npm run build` so a verification build doesn't replace the one
`next start` is serving.

### The scheduler

`lib/worker.ts` ticks every 60 seconds and advances any lead whose wait has elapsed, oldest first,
strictly one at a time — 8 GB of VRAM won't serve concurrent conversations, and `turn_count` is a
read-then-write with no atomicity, so overlapping advances on one lead would both write the same
value.

It's started from the root layout rather than Next's `instrumentation.ts`, which is compiled for the
Edge runtime too: the bundler traces the import chain regardless of any `NEXT_RUNTIME` guard, and
`node:fs` three modules down fails the build. Its state lives on `globalThis` because dev
recompilation re-evaluates modules, and a module-level guard would let each reload start another
interval.

**It only ticks while the app is running.** "Wait 3 days" means "3 days, and then the next time the
app is open." Nothing is skipped — the first tick after a restart picks up everything overdue — but
it is late, so the board shows each lead's due time and flags anything already past it.

`next dev` builds into `.next-dev` and `next build` into `.next`, set in `next.config.ts`. Both
default to `.next`, and running a build while a dev server is up leaves a half-overwritten directory
— chunks 404, pages 500 with `Cannot find module './611.js'`, and a later `npm start` serves a page
with **no styling at all**. The symptoms point nowhere near the cause, hence the split.

If a page ever renders as bare unstyled HTML, that's the signal: stop the server,
`rm -rf .next .next-dev`, and rebuild.

| Path | What it is |
| --- | --- |
| `lib/csv.ts` | Fillout parsing + phone/name/channel normalisation. Pure, well tested |
| `lib/db.ts` | `node:sqlite` connection + migrations + row types |
| `lib/leads.ts` | Data layer: import, stage machine, the thread allowlist, messages |
| `lib/playbook.ts` | Guard evaluation, turn planning, the send guardrails, grounding. Pure |
| `lib/qualify.ts` | One AI turn, channel-agnostic: plan → generate → validate → re-plan |
| `lib/brain.ts` | Playbook/character storage and the JSON export/import |
| `lib/connections.ts` | Named model connections; `providerConfigFor()` resolves a character's model |
| `lib/workflow.ts` | The step graph: types, validation, spec upgrade. Pure, client-safe |
| `lib/worker.ts` | The 60s scheduler that fires the waits |
| `lib/prompt.ts` | The prompt layer: defaults, placeholders, assembly. Pure, client-safe |
| `lib/promptStore.ts` | Loading/saving the layer. Server-only — kept apart so the editor can import the types |
| `lib/llm/` | `providers.ts` is client-safe; the index and adapters are server-only |
| `app/actions.ts` | Server actions for every UI mutation |
| `app/page.tsx` | The pipeline board |
| `app/leads/[id]/` | Lead detail: transcript, editable contacts, takeover |

`lib/csv.ts`, `lib/leads.ts`, `lib/playbook.ts` and `lib/qualify.ts` hold the logic most likely to be
wrong and carry the tests to match. Several tests exist because the behaviour was observed failing
against a real model, and the comments say which — worth reading before loosening any of them.

**Client components must not import server-only modules.** Doing so pulls `config` → `db` →
`node:sqlite`/`node:fs` into the browser bundle and the build fails with an error whose import trace
points at the leaf file rather than the module that crossed the line. It happened twice — `lib/llm`
in the Settings form, `lib/prompt` in the Rules editor — so `lib/__tests__/client-boundary.test.ts`
now fails the build instead. The fix is always the same shape: split the pure half from the half
that touches the database (`lib/llm/providers`, `lib/prompt`) and import that. `import type` is fine
either way; it's erased.

Uses Node's builtin `node:sqlite` rather than `better-sqlite3` deliberately — no native module means
no compiler toolchain when a teammate installs this on Windows.
