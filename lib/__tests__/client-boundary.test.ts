import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Client components must not reach server-only modules.
 *
 * Importing one pulls the whole chain — config → db → node:sqlite / node:fs —
 * into the browser bundle, and the build fails with
 * "UnhandledSchemeError: Reading from node:fs is not handled", whose import
 * trace points at the leaf file rather than the module that actually crossed
 * the line. It has happened twice: once from `lib/llm` in the Settings form,
 * once from `lib/prompt` in the Rules editor. Both cost more time to diagnose
 * than to fix.
 *
 * The fix each time was the same shape: split the pure half (types, constants,
 * pure functions) from the half that touches the database, and have client code
 * import the pure half.
 */

const ROOT = join(__dirname, "..", "..");

/** Modules that read or write the database, directly or transitively. */
const SERVER_ONLY = [
  "@/lib/db",
  "@/lib/config",
  "@/lib/leads",
  "@/lib/brain",
  "@/lib/connections",
  "@/lib/conversation",
  "@/lib/promptStore",
  "@/lib/criteriaStore", // @/lib/criteria is the client-safe half
  "@/lib/llm", // the index; @/lib/llm/providers is the client-safe half
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Value imports only.
 *
 * `import type { X } from "@/lib/conversation"` is erased at compile time and
 * never reaches the bundle, so it's legitimate in a client component and must
 * not be flagged — several already rely on it for shared result types.
 */
function importsOf(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:^|\n)\s*import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) specs.push(m[1]);
  return specs;
}

describe("client components stay out of server-only modules", () => {
  const clientFiles = walk(join(ROOT, "app"))
    .concat(walk(join(ROOT, "components")))
    .filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));

  it("finds the client components to check", () => {
    // A guard on the guard: if the glob silently matched nothing, the rest of
    // this file would pass while checking exactly zero files.
    expect(clientFiles.length).toBeGreaterThan(5);
  });

  it.each(clientFiles.map((f) => [f.slice(ROOT.length + 1).replace(/\\/g, "/"), f]))(
    "%s",
    (_label, file) => {
      // Exact match only: `@/lib/llm` is the server index and is banned, while
      // `@/lib/llm/providers` is the pure half and is exactly what to use.
      const offenders = importsOf(readFileSync(file, "utf8")).filter((spec) =>
        SERVER_ONLY.includes(spec),
      );
      expect(
        offenders,
        `Import the pure half instead (e.g. @/lib/llm/providers), or move what you need out of the database-touching module.`,
      ).toEqual([]);
    },
  );
});
