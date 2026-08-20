export const metadata = { title: "Stats — Outreach AI" };

export default function StatsPage() {
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center">
      <h1 className="text-base font-semibold text-neutral-900">Character performance</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
        Coming in phase 7: reply rate, conversion rate and accuracy rate per character. Accuracy
        comes from you agreeing or disagreeing with the AI&rsquo;s verdict at the decision stage, so
        the number only exists once reviews do.
      </p>
    </div>
  );
}
