/**
 * The scheduler: what makes "wait 3 days, then follow up" actually happen.
 *
 * A 60-second tick that advances every lead whose wait has elapsed. Started
 * from instrumentation.ts when the server boots, or standalone via
 * `npm run worker` if you'd rather watch its logs separately.
 *
 * The honest limitation of running locally: this only ticks while the app is
 * running. "Wait 3 days" means "3 days, and then the next time the app is
 * open." Nothing is skipped — the first tick after a restart picks up
 * everything overdue, oldest first — it's just late. The lead's due time is on
 * the board so lateness is visible rather than silent.
 */

import { dueLeads, setLeadError } from "./leads";
import { runStep } from "./conversation";

const TICK_MS = 60_000;
/** How many leads one tick will work through before yielding to the next. */
const BATCH = 25;

/**
 * State on globalThis, not module scope.
 *
 * In development Next re-evaluates modules on every recompile, so a
 * module-level guard resets and each reload starts another interval — the old
 * ones keep ticking against a stale closure, and leads get processed twice.
 * A global survives the reload; production evaluates once either way.
 */
const STATE = Symbol.for("outreach-ai.worker");
interface WorkerState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}
const g = globalThis as unknown as Record<symbol, WorkerState | undefined>;
if (!g[STATE]) g[STATE] = { timer: null, running: false };
const state = g[STATE]!;

export interface TickSummary {
  considered: number;
  advanced: number;
  blocked: number;
  skipped: number;
}

/**
 * Advance every lead that's due.
 *
 * Strictly one at a time. Two reasons, and both are real: 8 GB of VRAM will not
 * serve concurrent conversations, and `turn_count` is incremented with a
 * read-then-write that has no atomicity — two overlapping advances on one lead
 * would both write the same value. Serialising sidesteps that rather than
 * papering over it.
 */
export async function tick(): Promise<TickSummary> {
  const summary: TickSummary = { considered: 0, advanced: 0, blocked: 0, skipped: 0 };
  const leads = dueLeads(BATCH);
  summary.considered = leads.length;

  for (const lead of leads) {
    try {
      const result = await runStep(lead.id);
      if (result.kind === "blocked") summary.blocked++;
      else if (result.kind === "skipped") summary.skipped++;
      else summary.advanced++;
    } catch (e) {
      // One bad lead must not stop the queue. Record it against that lead and
      // carry on — otherwise a single unparseable model response would stall
      // every other conversation behind it.
      summary.blocked++;
      setLeadError(lead.id, (e as Error).message);
      console.error(`[worker] lead ${lead.id}:`, (e as Error).message);
    }
  }
  return summary;
}

async function safeTick(): Promise<void> {
  // A slow model turn can outlast the interval. Skip rather than overlap —
  // the next tick is 60 seconds away and nothing is lost by waiting.
  if (state.running) return;
  state.running = true;
  try {
    const s = await tick();
    if (s.advanced || s.blocked) {
      console.log(
        `[worker] ${s.advanced} advanced, ${s.blocked} blocked, ${s.skipped} skipped`,
      );
    }
  } finally {
    state.running = false;
  }
}

/**
 * Start the scheduler. Idempotent — the server-rendered layout calls this on
 * every request and only the first one does anything.
 *
 * Deliberately not Next's `instrumentation.ts` hook: that file is compiled for
 * the Edge runtime as well as Node, and the bundler traces the import chain
 * regardless of any `NEXT_RUNTIME` guard — so `node:fs`, three modules down in
 * lib/db.ts, fails the build with an error pointing at the leaf file. A server
 * component is only ever Node, so the problem doesn't arise.
 */
export function startPollLoop(): void {
  if (state.timer) return;
  console.log("[worker] scheduler started, ticking every 60s");
  // Catch up immediately: after the app has been closed for a while there is
  // usually a backlog, and waiting a further minute to start on it is silly.
  void safeTick();
  state.timer = setInterval(() => void safeTick(), TICK_MS);
  // Don't hold the process open on its own account.
  const t = state.timer as unknown as { unref?: () => void };
  t.unref?.();
}

export function stopPollLoop(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}
