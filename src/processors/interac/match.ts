import type { InteracTransfer } from './index';

/** Minimal subset of Lunch Money transactions used by Interac matching. */
export interface InteracCandidate {
  id: number;
  date: string; // YYYY-MM-DD
  amount: string | number; // Lunch Money signed amount in dollars
  payee: string;
  original_name?: string | null;
  notes?: string | null;
  status?: string | null;
  recurring_id?: number | null;
}

export interface InteracMatch {
  transaction: InteracCandidate;
  bank: 'ATB' | 'TD';
  /** Omit payee to keep Lunch Money's current value intact. */
  payee?: string;
  note: string;
}

export type InteracMatchResult =
  | { kind: 'matched'; value: InteracMatch }
  | { kind: 'none' | 'ambiguous'; candidates: number };

function dateNumber(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso ? t : null;
}

function daysBetween(transactionDate: string, notificationDate: string): number | null {
  const a = dateNumber(transactionDate);
  const b = dateNumber(notificationDate);
  return a === null || b === null ? null : Math.round((a - b) / 86_400_000);
}

function amountCents(amount: string | number): number | null {
  const value = Number(amount);
  const cents = Math.round(value * 100);
  return Number.isFinite(value) && Number.isSafeInteger(cents) &&
    Math.abs(value * 100 - cents) < 0.0001 ? cents : null;
}

function bankInfo(original: string): { bank: 'ATB' | 'TD'; direction: 'incoming' | 'outgoing'; suffix?: string; shortName?: string } | null {
  const desc = original.trim();
  const tdOut = desc.match(/^SEND\s+E-TFR\s+\*{3}([a-z0-9]{3})\s*$/i);
  if (tdOut) return { bank: 'TD', direction: 'outgoing', suffix: tdOut[1] };
  const atbIn = desc.match(/^INTERAC\s+e-Transfer\s+Autodep\s+Rcvd\s*-\s*(.+)$/i);
  if (atbIn) return { bank: 'ATB', direction: 'incoming', shortName: atbIn[1].trim() };
  const atbOut = desc.match(/^Interac\s+e-Transfer\s+Sent(?:-Autodep)?\s*-\s*(.+)$/i);
  if (atbOut) return { bank: 'ATB', direction: 'outgoing', shortName: atbOut[1].trim() };
  return null;
}

function dateAllowed(transfer: InteracTransfer, offset: number): boolean {
  if (transfer.direction === 'incoming') return offset >= -2 && offset <= 2;
  if (transfer.completion === 'accepted') return offset >= -14 && offset <= 1;
  return offset >= -3 && offset <= 1;
}

/**
 * Pure, no-write matching. No guessing, fuzzy names, account inference, or
 * changes to transactions that already have notes / have been reviewed.
 *
 * IMPORTANT: Only pass eligible transactions from the intended bank accounts.
 * Bank-account scope must be verified by the integration before live use.
 */
export function matchInteracTransfer(
  transfer: InteracTransfer,
  transactions: readonly InteracCandidate[],
): InteracMatchResult {
  const expectedCents = transfer.amountCents * (transfer.direction === 'incoming' ? -1 : 1);
  const eligible = transactions.flatMap(txn => {
    if (txn.status !== 'uncleared' || txn.recurring_id != null || Boolean(txn.notes?.trim())) return [];
    const original = txn.original_name ?? txn.payee;
    const info = bankInfo(original);
    if (!info || info.direction !== transfer.direction) return [];
    if (amountCents(txn.amount) !== expectedCents) return [];
    const offset = daysBetween(txn.date, transfer.transferDate);
    if (offset === null || !dateAllowed(transfer, offset)) return [];
    if (info.bank === 'ATB' && !/\bATB\b/i.test(transfer.institution)) return [];
    if (info.bank === 'TD' && !/^TD\b/i.test(transfer.institution)) return [];
    if (info.bank === 'TD' && info.suffix?.toLowerCase() !== transfer.reference.slice(-3).toLowerCase()) return [];
    return [{ txn, info }];
  });

  if (eligible.length === 0) return { kind: 'none', candidates: 0 };
  if (eligible.length !== 1) return { kind: 'ambiguous', candidates: eligible.length };

  const { txn, info } = eligible[0];
  const details = [
    transfer.message,
    `Interac ${transfer.direction === 'incoming' ? 'sender' : 'recipient'}: ${transfer.counterparty}`,
    `Reference: ${transfer.reference}`,
  ].filter(Boolean);
  const note = details.join(' | ');
  // Preserve anything already renamed by the user or Lunch Money rules.
  const currentUnchanged = txn.payee === (txn.original_name ?? txn.payee);
  const proposedPayee = currentUnchanged
    ? info.bank === 'ATB' ? info.shortName : transfer.counterparty
    : undefined;
  return {
    kind: 'matched', value: {
      transaction: txn,
      bank: info.bank,
      ...(proposedPayee ? { payee: proposedPayee } : {}),
      note,
    }
  };
}
