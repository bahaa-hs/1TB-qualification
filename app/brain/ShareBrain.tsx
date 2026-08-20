"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/primitives";
import { exportBrainAction, importBrainAction } from "./actions";

/**
 * Everyone runs their own database, so this is how one person authors the
 * qualification flow and the rest of the team gets it.
 */
export function ShareBrain() {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function download() {
    start(async () => {
      const data = await exportBrainAction();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "outreach-ai-brain.json";
      a.click();
      URL.revokeObjectURL(url);
      setMessage({ ok: true, text: "Exported. Send that file to your team." });
    });
  }

  function upload(file: File) {
    start(async () => {
      try {
        const r = await importBrainAction(await file.text());
        setMessage({
          ok: true,
          text: `Imported ${r.playbooks} playbook(s) and ${r.characters} character(s).`,
        });
        // The server action revalidated, but the editors hold their own state.
        location.reload();
      } catch (e) {
        setMessage({ ok: false, text: (e as Error).message });
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button variant="ghost" disabled={pending} onClick={download}>
          Export
        </Button>
        <Button variant="ghost" disabled={pending} onClick={() => fileRef.current?.click()}>
          Import
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = "";
          }}
        />
      </div>
      {message && (
        <span className={`text-xs ${message.ok ? "text-green-700" : "text-red-700"}`}>
          {message.text}
        </span>
      )}
    </div>
  );
}
