import { getSetting } from "@/lib/config";
import { listConnections } from "@/lib/connections";
import { Connections, type ConnectionView } from "./Connections";
import { IntegrationsForm } from "./IntegrationsForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings — Outreach AI" };

export default function SettingsPage() {
  const connections: ConnectionView[] = listConnections().map((c) => ({
    id: c.id,
    name: c.name,
    provider: c.provider,
    baseUrl: c.base_url,
    apiKey: c.api_key ?? "",
    model: c.model,
    isDefault: c.is_default === 1,
  }));

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Everything here is stored on this machine only.
        </p>
      </div>

      <Connections connections={connections} />

      <IntegrationsForm
        initial={{
          heyreachApiKey: getSetting("heyreach.apiKey") ?? "",
          heyreachCampaignId: getSetting("heyreach.campaignId") ?? "",
          heyreachAccountId: getSetting("heyreach.linkedInAccountId") ?? "",
          telegramBotToken: getSetting("telegram.botToken") ?? "",
        }}
      />

      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-900">Mailbox</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Connecting a Google account for email outreach comes in phase 4.
        </p>
      </section>
    </div>
  );
}
