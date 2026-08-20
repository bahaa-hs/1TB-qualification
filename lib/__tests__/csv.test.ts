import { describe, expect, it } from "vitest";
import {
  normalizeChannel,
  normalizeName,
  normalizePhone,
  normalizeTelegram,
  parseCsv,
  parseFilloutCsv,
} from "../csv";

describe("parseCsv", () => {
  it("parses plain rows", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields with commas, newlines and escaped quotes", () => {
    const text = 'a,b\n"x, y","line1\nline2"\n"say ""hi""",z\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ["x, y", "line1\nline2"],
      ['say "hi"', "z"],
    ]);
  });

  it("handles CRLF and a missing trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a UTF-8 BOM from the first header", () => {
    expect(parseCsv("﻿Submission ID,x\n1,2\n")[0][0]).toBe("Submission ID");
  });
});

describe("normalizePhone", () => {
  it("keeps a well-formed international number", () => {
    expect(normalizePhone("+923187958826")).toEqual({ e164: "+923187958826" });
  });

  it("strips spaces, dashes and parens", () => {
    expect(normalizePhone("+92 (318) 795-8826").e164).toBe("+923187958826");
  });

  it("converts a 00 prefix to +", () => {
    expect(normalizePhone("00923187958826").e164).toBe("+923187958826");
  });

  it("adds the + to a bare international number", () => {
    expect(normalizePhone("923187958826").e164).toBe("+923187958826");
  });

  it("refuses to guess at Excel scientific notation", () => {
    // This is the real value from the sample export. 9.23188E+11 keeps only 6
    // significant digits of a 12-digit number — the rest are genuinely gone, so
    // returning ANY number here would be inventing one.
    const r = normalizePhone("9.23188E+11");
    expect(r.e164).toBeNull();
    expect(r.warning).toMatch(/mangled/i);
  });

  it("rejects numbers that are too short or too long", () => {
    expect(normalizePhone("12345").e164).toBeNull();
    expect(normalizePhone("1234567890123456789").e164).toBeNull();
  });

  it("treats blank input as absent, not as an error", () => {
    expect(normalizePhone("")).toEqual({ e164: null });
    expect(normalizePhone(null)).toEqual({ e164: null });
    expect(normalizePhone(undefined).warning).toBeUndefined();
  });
});

describe("normalizeTelegram", () => {
  it("normalises bare and @-prefixed handles to the same thing", () => {
    expect(normalizeTelegram("kat675")).toBe("kat675");
    expect(normalizeTelegram("@xiaoqill1")).toBe("xiaoqill1");
  });

  it("strips a t.me url", () => {
    expect(normalizeTelegram("https://t.me/someone")).toBe("someone");
  });

  it("returns null for blanks", () => {
    expect(normalizeTelegram("  ")).toBeNull();
    expect(normalizeTelegram(undefined)).toBeNull();
  });
});

describe("normalizeName", () => {
  it("drops a surname duplicated into the first-name field", () => {
    // Real row: First name "prince chohan", Last name "chohan".
    expect(normalizeName("prince chohan", "chohan")).toEqual({
      firstName: "prince",
      lastName: "chohan",
    });
  });

  it("is case-insensitive about the duplicate", () => {
    expect(normalizeName("Prince Chohan", "chohan").firstName).toBe("Prince");
  });

  it("leaves an ordinary name alone", () => {
    expect(normalizeName("Mark", "Wilson")).toEqual({ firstName: "Mark", lastName: "Wilson" });
  });

  it("does not strip a genuine multi-word first name", () => {
    expect(normalizeName("Mary Jane", "Watson").firstName).toBe("Mary Jane");
  });
});

describe("normalizeChannel", () => {
  it("maps the values the form actually produces", () => {
    expect(normalizeChannel("LinkedIn Messenger")).toBe("linkedin");
    expect(normalizeChannel("Telegram")).toBe("telegram");
    expect(normalizeChannel("Whatsapp")).toBe("whatsapp");
  });

  it("tolerates spacing and case variants", () => {
    expect(normalizeChannel("whats app")).toBe("whatsapp");
    expect(normalizeChannel("linked in")).toBe("linkedin");
  });

  it("returns null for unknown values so the caller can warn", () => {
    expect(normalizeChannel("Carrier pigeon")).toBeNull();
    expect(normalizeChannel("")).toBeNull();
  });
});

// A trimmed copy of the real Fillout export, including the blank padding row.
const SAMPLE = [
  "Submission ID,Last updated,Submission started,Status,Current step,First name,Last name,Company website,Email address,LinkedIn profile link,How can we contact you?,Phone number,Whatsapp,Telegram,Skype,Expected monthly traffic volume,I meet the following criteria for approval:,email,Errors,Url,Network ID",
  "b587709a,x,x,finished,Ending,Mark,Wilson,techproxy-solutions.com,2264696502@qq.com,https://linkedin.com/in/markwilson-tech,LinkedIn Messenger,,,,,1TB+,TRUE,,None,https://u,net1",
  "8332b8eb,x,x,finished,Ending,Weibo,Jiang,https://bluesketch.net/,mxaigc@gmail.com,https://cn.linkedin.com/company/bluesketch,Telegram,,,kat675,,1TB+,TRUE,,None,https://u,net2",
  "066b89cc,x,x,finished,Ending,prince chohan,chohan,https://www.linkedin.com/in/prince-chohan,princechohan4u@gmail.com,https://www.linkedin.com/in/prince-chohan,Whatsapp,,9.23188E+11,,,1TB+,TRUE,,None,https://u,net3",
  ",,,,,,,,,,,,,,,,,,,,",
].join("\n");

describe("parseFilloutCsv", () => {
  const result = parseFilloutCsv(SAMPLE);

  it("skips rows with no Submission ID", () => {
    expect(result.leads).toHaveLength(3);
    expect(result.skipped).toBe(1);
  });

  it("recognises every column in the real export", () => {
    expect(result.unknownColumns).toEqual([]);
  });

  it("maps the preferred channel", () => {
    expect(result.leads.map((l) => l.preferredChannel)).toEqual([
      "linkedin",
      "telegram",
      "whatsapp",
    ]);
  });

  it("flags the mangled phone number instead of importing it", () => {
    const prince = result.leads[2];
    expect(prince.whatsappE164).toBeNull();
    expect(prince.whatsappRaw).toBe("9.23188E+11");
    expect(prince.warnings.some((w) => /mangled/i.test(w))).toBe(true);
  });

  it("normalises the duplicated first name", () => {
    expect(result.leads[2].firstName).toBe("prince");
  });

  it("accepts free-provider emails without complaint", () => {
    expect(result.leads[1].email).toBe("mxaigc@gmail.com");
    expect(result.leads[1].warnings).toEqual([]);
  });

  it("keeps a LinkedIn URL sitting in the company website column", () => {
    // Not an error — a lead may simply not have a company site.
    expect(result.leads[2].companyWebsite).toContain("linkedin.com");
    expect(result.leads[2].warnings.some((w) => /website/i.test(w))).toBe(false);
  });

  it("preserves the original row verbatim", () => {
    expect(result.leads[0].rawRow["Network ID"]).toBe("net1");
  });
});
