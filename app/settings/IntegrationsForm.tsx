"use client";

import { useState, useTransition } from "react";
import { Button, Field, Input } from "@/components/ui/primitives";
import { saveIntegrationsAction } from "./actions";

interface Integrations {
  heyreachApiKey: string;
  heyreachCampaignId: string;
  heyreachAccountId: string;
  telegramBotToken: string;
}

export function IntegrationsForm({ initial }: { initial: Integrations }) {
  const [form, setForm] = useState(initial);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  const set = (k: keyof Integrations) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setSaved(false);
  };

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-900">Channels</h2>
        {saved && <span className="text-xs text-green-700">Saved</span>}
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        Optional. Without these the tool still works on email and the manual relay.
      </p>

      <div className="mt-4 space-y-3">
        <Field label="HeyReach API key" hint="For LinkedIn. Wired up in phase 5.">
          <Input
            type="password"
            value={form.heyreachApiKey}
            onChange={set("heyreachApiKey")}
            placeholder="…"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Campaign ID">
            <Input value={form.heyreachCampaignId} onChange={set("heyreachCampaignId")} />
          </Field>
          <Field label="LinkedIn sender ID" hint="Optional">
            <Input value={form.heyreachAccountId} onChange={set("heyreachAccountId")} />
          </Field>
        </div>
        <Field label="Telegram bot token" hint="From @BotFather. Wired up in phase 6.">
          <Input
            type="password"
            value={form.telegramBotToken}
            onChange={set("telegramBotToken")}
            placeholder="123456:ABC…"
          />
        </Field>
      </div>

      <div className="mt-4">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              await saveIntegrationsAction(form);
              setSaved(true);
            })
          }
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}
