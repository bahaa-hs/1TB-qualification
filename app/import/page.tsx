import { ImportForm } from "./ImportForm";

export const metadata = { title: "Import — Outreach AI" };

export default function ImportPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-lg font-semibold tracking-tight">Import leads</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Upload a Fillout CSV export. Leads are matched on their Submission ID, so re-uploading the
        same file updates rather than duplicates — and any contact detail you&rsquo;ve corrected by
        hand is kept.
      </p>
      <div className="mt-6">
        <ImportForm />
      </div>
    </div>
  );
}
