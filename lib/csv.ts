/**
 * Fillout CSV parsing and normalisation.
 *
 * Everything here is pure — no database, no network — because this is the layer
 * most likely to be subtly wrong and it needs to be testable in isolation.
 * See lib/__tests__/csv.test.ts.
 */

export type Channel = "email" | "whatsapp" | "telegram" | "linkedin";

export interface ParsedLead {
  submissionId: string;
  firstName: string;
  lastName: string;
  email: string;
  companyWebsite: string | null;
  linkedinUrl: string | null;
  preferredChannel: Channel | null;
  /** Normalised E.164, or null when the input was unusable. */
  whatsappE164: string | null;
  /** What the CSV actually contained, kept so a human can see what to fix. */
  whatsappRaw: string | null;
  telegramHandle: string | null;
  expectedVolume: string | null;
  rawRow: Record<string, string>;
  warnings: string[];
}

export interface ParseResult {
  leads: ParsedLead[];
  /** Rows with no Submission ID — blank padding, or genuinely malformed. */
  skipped: number;
  /** Header names we didn't recognise, surfaced so a form change is visible. */
  unknownColumns: string[];
}

// ─── RFC 4180 ────────────────────────────────────────────────────────────────

/**
 * Split CSV text into rows of fields. Handles quoted fields containing commas,
 * newlines and doubled quotes; tolerates both CRLF and LF.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++; // handled by the \n that follows
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }

  // trailing field / row with no terminating newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ─── Field normalisation ─────────────────────────────────────────────────────

/** Excel's display form for a large number, e.g. "9.23188E+11". */
const SCIENTIFIC = /^\d+(\.\d+)?[eE][+-]?\d+$/;

export interface PhoneResult {
  e164: string | null;
  warning?: string;
}

/**
 * Normalise a phone number to E.164.
 *
 * The important case is scientific notation. "9.23188E+11" is Excel having
 * rendered a 12-digit number with 6 significant digits — the remaining digits
 * are genuinely gone and no amount of parsing recovers them. We refuse to guess
 * and flag the lead instead, because a plausible-but-wrong number is worse than
 * an obviously missing one.
 */
export function normalizePhone(raw: string | null | undefined): PhoneResult {
  const input = (raw ?? "").trim();
  if (!input) return { e164: null };

  if (SCIENTIFIC.test(input)) {
    return {
      e164: null,
      warning: `Phone number "${input}" was mangled by the spreadsheet export — digits are lost. Enter it by hand.`,
    };
  }

  // Keep digits only, remembering whether the caller wrote an international
  // prefix in some form.
  const hadPlus = input.startsWith("+");
  let digits = input.replace(/\D/g, "");

  if (!hadPlus && digits.startsWith("00")) digits = digits.slice(2);

  if (digits.length < 8 || digits.length > 15) {
    return {
      e164: null,
      warning: `Phone number "${input}" doesn't look like a valid international number. Enter it by hand.`,
    };
  }
  return { e164: `+${digits}` };
}

/** Strip a leading @ and any t.me/ prefix so handles compare consistently. */
export function normalizeTelegram(raw: string | null | undefined): string | null {
  let v = (raw ?? "").trim();
  if (!v) return null;
  v = v.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "");
  v = v.replace(/^@+/, "");
  return v || null;
}

/**
 * Fillout sometimes puts the whole name in "First name" while "Last name" holds
 * just the surname — e.g. first "prince chohan", last "chohan". Drop the
 * duplicated surname so greetings don't read "Hi prince chohan,".
 */
export function normalizeName(
  firstRaw: string | null | undefined,
  lastRaw: string | null | undefined,
): { firstName: string; lastName: string } {
  const first = (firstRaw ?? "").trim().replace(/\s+/g, " ");
  const last = (lastRaw ?? "").trim().replace(/\s+/g, " ");
  if (!first || !last) return { firstName: first, lastName: last };

  const parts = first.split(" ");
  if (parts.length > 1 && parts[parts.length - 1].toLowerCase() === last.toLowerCase()) {
    return { firstName: parts.slice(0, -1).join(" "), lastName: last };
  }
  return { firstName: first, lastName: last };
}

const CHANNEL_ALIASES: [RegExp, Channel][] = [
  [/linked\s*in/i, "linkedin"],
  [/telegram/i, "telegram"],
  [/whats\s*app/i, "whatsapp"],
  [/e-?mail/i, "email"],
];

export function normalizeChannel(raw: string | null | undefined): Channel | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  for (const [re, channel] of CHANNEL_ALIASES) {
    if (re.test(v)) return channel;
  }
  return null;
}

// ─── Fillout row mapping ─────────────────────────────────────────────────────

const KNOWN_COLUMNS = new Set([
  "Submission ID", "Last updated", "Submission started", "Status", "Current step",
  "First name", "Last name", "Company website", "Email address",
  "LinkedIn profile link", "How can we contact you?", "Phone number", "Whatsapp",
  "Telegram", "Skype", "Expected monthly traffic volume",
  "I meet the following criteria for approval:", "email", "Errors", "Url",
  "Network ID",
]);

const clean = (v: string | undefined): string => (v ?? "").trim();
const orNull = (v: string | undefined): string | null => clean(v) || null;

/**
 * Parse a Fillout export into leads.
 *
 * Rows without a Submission ID are skipped — the sample export carried ~1000
 * blank padding rows. Harmless if a future export has none.
 */
export function parseFilloutCsv(text: string): ParseResult {
  const rows = parseCsv(text);
  if (rows.length === 0) return { leads: [], skipped: 0, unknownColumns: [] };

  const header = rows[0].map((h) => h.trim());
  const unknownColumns = header.filter((h) => h && !KNOWN_COLUMNS.has(h));

  const leads: ParsedLead[] = [];
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const rawRow: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      if (header[c]) rawRow[header[c]] = rows[r][c] ?? "";
    }

    const submissionId = clean(rawRow["Submission ID"]);
    if (!submissionId) {
      skipped++;
      continue;
    }

    const warnings: string[] = [];

    // Two email columns exist; prefer the populated one.
    const email = clean(rawRow["Email address"]) || clean(rawRow["email"]);
    if (!email) warnings.push("No email address on the submission.");

    const { firstName, lastName } = normalizeName(rawRow["First name"], rawRow["Last name"]);

    // The dedicated Whatsapp column first, then the generic phone field.
    const whatsappRaw = clean(rawRow["Whatsapp"]) || clean(rawRow["Phone number"]) || null;
    const phone = normalizePhone(whatsappRaw);
    if (phone.warning) warnings.push(phone.warning);

    const preferredChannel = normalizeChannel(rawRow["How can we contact you?"]);
    if (!preferredChannel && clean(rawRow["How can we contact you?"])) {
      warnings.push(
        `Unrecognised preferred channel "${clean(rawRow["How can we contact you?"])}" — set it by hand.`,
      );
    }

    leads.push({
      submissionId,
      firstName,
      lastName,
      email,
      companyWebsite: orNull(rawRow["Company website"]),
      linkedinUrl: orNull(rawRow["LinkedIn profile link"]),
      preferredChannel,
      whatsappE164: phone.e164,
      whatsappRaw,
      telegramHandle: normalizeTelegram(rawRow["Telegram"]),
      expectedVolume: orNull(rawRow["Expected monthly traffic volume"]),
      rawRow,
      warnings,
    });
  }

  return { leads, skipped, unknownColumns };
}
