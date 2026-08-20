"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/primitives";
import { importCsvAction } from "../actions";
import type { ImportSummary } from "@/lib/leads";

export function ImportForm() {
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(formData: FormData) {
    setError(null);
    setSummary(null);
    start(async () => {
      try {
        setSummary(await importCsvAction(formData));
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  return (
    <form action={submit} className="space-y-4">
      <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-neutral-300 bg-white px-6 py-10 text-center transition-colors hover:border-neutral-400">
        <input
          ref={inputRef}
          type="file"
          name="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => setFilename(e.target.files?.[0]?.name ?? null)}
        />
        <span className="text-sm font-medium text-neutral-800">
          {filename ?? "Choose a CSV file"}
        </span>
        <span className="mt-1 text-xs text-neutral-400">Fillout export, .csv</span>
      </label>

      <Button type="submit" disabled={pending || !filename}>
        {pending ? "Importing…" : "Import"}
      </Button>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {summary && (
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="text-sm font-medium text-neutral-900">Import complete</div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
            <Stat label="New" value={summary.inserted} />
            <Stat label="Updated" value={summary.updated} />
            <Stat label="Blank rows skipped" value={summary.skipped} />
            <Stat label="Need fixing" value={summary.withWarnings} tone={summary.withWarnings > 0} />
          </dl>
          {summary.withWarnings > 0 && (
            <p className="mt-3 text-xs text-amber-700">
              {summary.withWarnings} lead{summary.withWarnings === 1 ? "" : "s"} came in with an
              unusable phone number or missing email. Open the lead and correct it — your edit
              won&rsquo;t be overwritten by a future import.
            </p>
          )}
          <Link
            href="/"
            className="mt-4 inline-block text-sm font-medium text-neutral-900 underline underline-offset-4"
          >
            Go to the pipeline →
          </Link>
        </div>
      )}
    </form>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-neutral-400">{label}</dt>
      <dd className={`text-lg font-semibold ${tone ? "text-amber-700" : "text-neutral-900"}`}>
        {value}
      </dd>
    </div>
  );
}
