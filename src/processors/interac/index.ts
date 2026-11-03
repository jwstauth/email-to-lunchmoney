import { convert as htmlToText } from 'html-to-text';
import type { Email } from 'postal-mime';

/**
 * Parse-only module. Deliberately NOT registered in DEFAULT_EMAIL_PROCESSORS:
 * the current LunchMoneyAction matching interface cannot safely represent
 * account/date/direction/reference-sensitive Interac matches.
 */
export interface InteracTransfer {
  direction: 'incoming' | 'outgoing';
  completion: 'auto_deposited' | 'deposited' | 'accepted';
  amountCents: number;
  currency: 'CAD';
  counterparty: string;
  accountHolder: string;
  institution: string;
  accountSuffix: string | null;
  reference: string;
  message: string | null;
  transferDate: string; // YYYY-MM-DD, as stated in Transfer Details
  emailTimestamp: string | null; // raw PostalMime date; do not equate with transfer date
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function matchesInteracEmail(email: Email): boolean {
  const address = email.from?.address?.trim().toLowerCase();
  return (address === 'notify@payments.interac.ca' ||
    address === 'catch@payments.interac.ca') &&
    /(?:interac\s+)?e-transfer\s*:/i.test(email.subject ?? '');
}

function stripSpaces(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseAmount(amount: string): number {
  const normalized = amount.replace(/,/g, '');
  if (!/^\d+\.\d{2}$/.test(normalized)) throw new Error('Invalid transfer amount');
  const [dollars, cents] = normalized.split('.');
  const total = Number(dollars) * 100 + Number(cents);
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Unsafe transfer amount');
  return total;
}

function parseDate(value: string): string {
  const match = stripSpaces(value).match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!match) throw new Error('Unrecognized Interac transfer date');
  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!month || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day) {
    throw new Error('Invalid Interac transfer date');
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Extract a value from the structured Transfer Details block (not the footer). */
function field(details: string, name: string): string | null {
  const headings = 'Date|Reference Number|Message|Sent From|Amount';
  const regex = new RegExp(
    `(?:^|\\n)\\s*${name}:\\s*\\n?([\\s\\S]*?)(?=\\n\\s*(?:${headings}):|\\n\\s*(?:FAQ|This is a secure transaction|For your security)|$)`,
    'i',
  );
  const match = details.match(regex);
  if (!match) return null;
  const cleaned = stripSpaces(match[1]);
  return cleaned || null;
}

/** Parse the three completed-transfer email formats sampled from ATB and TD. */
export function parseInteracEmail(email: Email): InteracTransfer {
  if (!matchesInteracEmail(email)) throw new Error('Not an Interac transfer notification');

  const subject = stripSpaces(email.subject ?? '').replace(/^(?:Interac\s+)?e-Transfer:\s*/i, '');
  const rawText = email.text ?? (email.html ? htmlToText(email.html, { wordwrap: false }) : '');
  const body = rawText.replace(/\r/g, '').replace(/\u00a0/g, ' ');
  const greeting = body.match(/\bHi\s+([^\n,]+),/i);
  const accountHolder = greeting ? stripSpaces(greeting[1]) : '';
  if (!accountHolder) throw new Error('Missing account holder in Interac notification');

  let direction: InteracTransfer['direction'];
  let completion: InteracTransfer['completion'];
  let counterparty: string;
  let amountCents: number;

  const incoming = subject.match(/^You've received \$([\d,]+\.\d{2}) from (.+?) and it has been automatically deposited\.?$/i);
  const outgoing = subject.match(/^Your \$([\d,]+\.\d{2}) transfer to (.+?) has been successfully deposited\.?$/i);
  const accepted = subject.match(/^(.+?) has accepted your transfer of \$([\d,]+\.\d{2})\.?$/i);
  const sender = email.from?.address?.toLowerCase();

  if (incoming && sender === 'notify@payments.interac.ca') {
    direction = 'incoming';
    completion = 'auto_deposited';
    amountCents = parseAmount(incoming[1]);
    counterparty = stripSpaces(incoming[2]);
    if (!/Funds Deposited!/i.test(body)) throw new Error('Incoming deposit not confirmed in body');
  } else if (outgoing && sender === 'catch@payments.interac.ca') {
    direction = 'outgoing';
    completion = 'deposited';
    amountCents = parseAmount(outgoing[1]);
    counterparty = stripSpaces(outgoing[2]);
    if (!/has been successfully deposited/i.test(body)) throw new Error('Outgoing deposit not confirmed in body');
  } else if (accepted && sender === 'catch@payments.interac.ca') {
    direction = 'outgoing';
    completion = 'accepted';
    amountCents = parseAmount(accepted[2]);
    counterparty = stripSpaces(accepted[1]);
    if (!/has been successfully deposited/i.test(body)) throw new Error('Acceptance not confirmed in body');
  } else {
    throw new Error('Unsupported or unconfirmed Interac notification format');
  }

  // Validate the exact amount again against the relevant confirmation text.
  const bodyAmount = direction === 'incoming'
    ? body.match(/Funds Deposited!\s*\$([\d,]+\.\d{2})/i)
    : completion === 'deposited'
      ? body.match(/The \$([\d,]+\.\d{2}) \(CAD\) you sent to/i)
      : body.match(/for the amount of \$([\d,]+\.\d{2}) \(CAD\)/i);
  if (!bodyAmount || parseAmount(bodyAmount[1]) !== amountCents) {
    throw new Error('Subject/body transfer amounts disagree');
  }

  const transferDetailsAt = body.search(/Transfer Details/i);
  if (transferDetailsAt < 0) throw new Error('Missing Transfer Details');
  const details = body.slice(transferDetailsAt + 'Transfer Details'.length);
  const reference = field(details, 'Reference Number');
  const transferDateText = field(details, 'Date');
  if (!reference || !/^[A-Za-z0-9]+$/.test(reference)) throw new Error('Missing/invalid Interac reference');
  if (!transferDateText) throw new Error('Missing Interac transfer date');

  const message = field(details, 'Message');
  const sentFrom = field(details, 'Sent From');
  if (direction === 'incoming' && sentFrom && stripSpaces(sentFrom).toLowerCase() !== counterparty.toLowerCase()) {
    throw new Error('Sender differs between subject and transfer details');
  }
  const bodyInstitution = body.match(/automatically deposited into your account at\s+([^\n.]+)\.?/i);
  const accountSuffix = body.match(/Account ending in\s+([A-Za-z0-9]+)/i)?.[1] ?? null;
  const institution = direction === 'incoming'
    ? stripSpaces(bodyInstitution?.[1] ?? '')
    : stripSpaces(email.from?.name ?? '');
  if (!institution) throw new Error('Missing financial institution');
  if (!counterparty) throw new Error('Missing counterparty');

  return {
    direction, completion, amountCents, currency: 'CAD', counterparty,
    accountHolder, institution, accountSuffix,
    reference, message, transferDate: parseDate(transferDateText),
    emailTimestamp: email.date ?? null,
  };
}
