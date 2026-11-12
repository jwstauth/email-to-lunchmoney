import { describe, expect, it } from 'vitest';
import type { InteracTransfer } from './index';
import { matchInteracTransfer, type InteracCandidate } from './match';

const base: InteracTransfer = {
  direction: 'outgoing', completion: 'deposited', amountCents: 21600,
  currency: 'CAD', counterparty: 'CFERKO (CLAY FERKO)',
  accountHolder: 'JEREMY STAUTH', institution: 'ATB Financial',
  accountSuffix: null, reference: 'C1ACFzVQfhz8',
  message: '10 Street window cleaning', transferDate: '2026-09-30',
  emailTimestamp: null,
};

const atb: InteracCandidate = {
  id: 1, date: '2026-09-29', amount: '216.0000', status: 'uncleared',
  payee: 'Interac e-Transfer Sent-Autodep - Clay (window cle',
  original_name: 'Interac e-Transfer Sent-Autodep - Clay (window cle',
  notes: null,
};

const tdTransfer: InteracTransfer = {
  ...base, amountCents: 28000, counterparty: 'MARYAM JARRAHI',
  institution: 'TD Canada Trust', reference: 'C1Aame6Gdn4g',
  message: 'week of Oct 26', transferDate: '2026-10-30',
};
const td: InteracCandidate = {
  id: 2, date: '2026-10-30', amount: '280.0000', status: 'uncleared',
  payee: 'SEND E-TFR ***n4g', original_name: 'SEND E-TFR ***n4g',
  notes: null,
};

describe('Interac candidate matching (no API writes)', () => {
  it('matches ATB without requiring the contact name to match the email name', () => {
    const result = matchInteracTransfer(base, [atb]);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.value.payee).toBe('Clay (window cle');
      expect(result.value.note).toContain('10 Street window cleaning');
    }
  });
  it('matches TD using the reference suffix', () => {
    const result = matchInteracTransfer(tdTransfer, [td]);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') expect(result.value.payee).toBe('MARYAM JARRAHI');
  });
  it('refuses a TD reference mismatch', () => {
    expect(matchInteracTransfer(tdTransfer, [{ ...td, original_name: 'SEND E-TFR ***abc' }]).kind).toBe('none');
  });
  it('does not choose arbitrarily between identical ATB amount/date candidates', () => {
    expect(matchInteracTransfer(base, [atb, { ...atb, id: 3 }])).toEqual({ kind: 'ambiguous', candidates: 2 });
  });
  it('preserves changed payees', () => {
    const result = matchInteracTransfer(base, [{ ...atb, payee: 'Clay (window cleaning)' }]);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') expect(result.value.payee).toBeUndefined();
  });
  it('does not touch reviewed, recurring, or annotated transactions', () => {
    expect(matchInteracTransfer(base, [{ ...atb, status: 'cleared' }]).kind).toBe('none');
    expect(matchInteracTransfer(base, [{ ...atb, recurring_id: 100 }]).kind).toBe('none');
    expect(matchInteracTransfer(base, [{ ...atb, notes: 'Already annotated' }]).kind).toBe('none');
  });
  it('matches ATB incoming deposits by negative amount', () => {
    const incoming: InteracTransfer = { ...base, direction: 'incoming', completion: 'auto_deposited', amountCents: 195000, counterparty: 'Felicia Kelley' };
    const txn: InteracCandidate = { ...atb, amount: '-1950.0000', original_name: 'INTERAC e-Transfer Autodep Rcvd- Felicia Kelley', payee: 'INTERAC e-Transfer Autodep Rcvd- Felicia Kelley' };
    expect(matchInteracTransfer(incoming, [txn]).kind).toBe('matched');
  });
  it('rejects wrong signed amount, date, and institution', () => {
    expect(matchInteracTransfer(base, [{ ...atb, amount: '-216.0000' }]).kind).toBe('none');
    expect(matchInteracTransfer(base, [{ ...atb, date: '2026-09-10' }]).kind).toBe('none');
    expect(matchInteracTransfer({ ...base, institution: 'TD Canada Trust' }, [atb]).kind).toBe('none');
  });
});
