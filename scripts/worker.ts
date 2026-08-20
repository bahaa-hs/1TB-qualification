/**
 * Standalone scheduler, for anyone who wants its logs separate from the app.
 *
 * `npm run worker`. Safe to run alongside the app — both tick the same table
 * and `runStep` refuses a lead that already has an unsent draft, so the worst
 * case is one of them finding nothing to do.
 */

import { startPollLoop, stopPollLoop } from "../lib/worker";

startPollLoop();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopPollLoop();
    process.exit(0);
  });
}

// startPollLoop unrefs its timer so it won't hold a server process open; a
// standalone run needs something that does.
setInterval(() => {}, 1 << 30);
