"use client";

// Copied from `word frequency/src/components/ui/primitives.tsx` so the two
// internal tools look and behave the same. Additions here: Input, Select,
// Textarea, Field — the form controls this tool needs and that one didn't.

import type { ReactNode } from "react";

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  type?: "button" | "submit";
  className?: string;
}) {
  const styles = {
    primary: "bg-neutral-900 text-white hover:bg-neutral-700",
    secondary: "border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100",
    ghost: "text-neutral-600 hover:bg-neutral-100",
    danger: "border border-red-300 bg-white text-red-700 hover:bg-red-50",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "gray" | "red" | "blue" | "amber";
}) {
  const styles = {
    neutral: "bg-neutral-100 text-neutral-700",
    green: "bg-green-100 text-green-800",
    gray: "bg-neutral-100 text-neutral-500",
    red: "bg-red-100 text-red-700",
    blue: "bg-blue-100 text-blue-800",
    amber: "bg-amber-100 text-amber-800",
  }[tone];
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}
    >
      {children}
    </span>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-neutral-100 p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            active === t.id
              ? "bg-white text-neutral-900 shadow-sm"
              : "text-neutral-500 hover:text-neutral-800"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Collapsible({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-neutral-200 bg-white">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-neutral-600 hover:text-neutral-900">
        {summary}
      </summary>
      <div className="border-t border-neutral-100 px-3 py-2">{children}</div>
    </details>
  );
}

export function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800 ${className}`}
    />
  );
}

const CONTROL =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none disabled:bg-neutral-100";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-neutral-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-neutral-400">{hint}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL} ${props.className ?? ""}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${CONTROL} ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${CONTROL} ${props.className ?? ""}`} />;
}
