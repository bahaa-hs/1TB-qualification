"use client";

import { useState, useTransition } from "react";
import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { normalizePhone, normalizeTelegram, type Channel } from "@/lib/csv";
import { updateContactAction } from "@/app/actions";

interface Contact {
  email: string;
  whatsappE164: string;
  telegramHandle: string;
  linkedinUrl: string;
  companyWebsite: string;
  preferredChannel: string;
}

/**
 * Editable contact details.
 *
 * This is the backup path for a phone number the spreadsheet export destroyed,
 * and the place to record anything picked up during a manual first touch. The
 * phone field runs through the same normalizePhone() the importer uses, so a
 * hand-typed number gets validated the same way rather than trusted blindly.
 */
export function ContactPanel({
  leadId,
  initial,
  whatsappRaw,
  editedBy,
  editedAt,
}: {
  leadId: number;
  initial: Contact;
  whatsappRaw: string | null;
  editedBy: string | null;
  editedAt: string | null;
}) {
  const [form, setForm] = useState<Contact>(initial);
  // What's currently persisted. Diverges from `initial` after a save, because
  // saving normalises values rather than storing them as typed.
  const [baseline, setBaseline] = useState<Contact>(initial);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = (Object.keys(baseline) as (keyof Contact)[]).some((k) => form[k] !== baseline[k]);
  const set = (k: keyof Contact) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setSaved(false);
    setError(null);
  };

  function save() {
    setError(null);
    const phoneInput = form.whatsappE164.trim();
    let whatsappE164: string | null = null;
    if (phoneInput) {
      const r = normalizePhone(phoneInput);
      if (!r.e164) {
        setError(r.warning ?? "That phone number doesn't look valid.");
        return;
      }
      whatsappE164 = r.e164;
    }

    // What we store is the normalised form, not what was typed. Mirror that
    // back into the inputs so the panel doesn't keep looking unsaved after a
    // successful save (typing "+92 318 795 8826" stores "+923187958826").
    const normalised: Contact = {
      email: form.email.trim(),
      whatsappE164: whatsappE164 ?? "",
      telegramHandle: normalizeTelegram(form.telegramHandle) ?? "",
      linkedinUrl: form.linkedinUrl.trim(),
      companyWebsite: form.companyWebsite.trim(),
      preferredChannel: form.preferredChannel,
    };

    start(async () => {
      try {
        await updateContactAction(leadId, {
          email: normalised.email || null,
          whatsappE164,
          telegramHandle: normalised.telegramHandle || null,
          linkedinUrl: normalised.linkedinUrl || null,
          companyWebsite: normalised.companyWebsite || null,
          preferredChannel: (normalised.preferredChannel || null) as Channel | null,
        });
        setForm(normalised);
        setBaseline(normalised);
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-medium text-neutral-500">Contact details</h3>
        {saved && <span className="text-xs text-green-700">Saved</span>}
      </div>

      <div className="space-y-3">
        <Field label="Email">
          <Input value={form.email} onChange={set("email")} placeholder="name@company.com" />
        </Field>

        <Field
          label="WhatsApp / phone"
          hint={
            !form.whatsappE164 && whatsappRaw
              ? `The export contained "${whatsappRaw}", which isn't a usable number.`
              : "International format, e.g. +923187958826"
          }
        >
          <Input value={form.whatsappE164} onChange={set("whatsappE164")} placeholder="+…" />
        </Field>

        <Field label="Telegram">
          <Input value={form.telegramHandle} onChange={set("telegramHandle")} placeholder="handle" />
        </Field>

        <Field label="LinkedIn">
          <Input value={form.linkedinUrl} onChange={set("linkedinUrl")} placeholder="https://…" />
        </Field>

        <Field label="Company website">
          <Input value={form.companyWebsite} onChange={set("companyWebsite")} placeholder="https://…" />
        </Field>

        <Field label="Preferred channel">
          <Select value={form.preferredChannel} onChange={set("preferredChannel")}>
            <option value="">Not set</option>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="telegram">Telegram</option>
            <option value="linkedin">LinkedIn</option>
          </Select>
        </Field>
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button onClick={save} disabled={!dirty || pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setForm(baseline)} disabled={pending}>
            Reset
          </Button>
        )}
      </div>

      {editedAt && (
        <p className="mt-2 text-xs text-neutral-400">
          Edited by {editedBy ?? "someone"} on {editedAt}. Future imports won&rsquo;t overwrite this.
        </p>
      )}
    </div>
  );
}
