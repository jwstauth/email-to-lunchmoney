import {afterEach, describe, expect, it, vi} from 'vitest';

import {processActions} from './lunchmoney';
import type {LunchMoneyInterac, LunchMoneyActionRow} from './types';

const transfer: LunchMoneyInterac['transfer'] = {
  direction: 'outgoing',
  completion: 'deposited',
  amountCents: 28000,
  currency: 'CAD',
  counterparty: 'MARYAM JARRAHI',
  accountHolder: 'MARYAM STAUTH',
  institution: 'TD Canada Trust',
  accountSuffix: null,
  reference: 'C1Aame6Gdn4g',
  message: 'week of Oct 26',
  transferDate: '2026-10-30',
  emailTimestamp: '2026-10-30T17:24:00',
};

function row(id = 1): LunchMoneyActionRow {
  return {
    id,
    source: 'interac',
    date_created: '2026-10-30T23:24:00Z',
    action: JSON.stringify({type: 'interac', transfer}),
  };
}

function tdTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    account_id: 20,
    date: '2026-10-30',
    amount: '-280.0000',
    payee: 'SEND E-TFR ***n4g',
    original_name: 'SEND E-TFR ***n4g',
    notes: null,
    status: 'uncleared',
    recurring_id: null,
    ...overrides,
  };
}

function harness(transactions: Record<string, unknown>[], options: {
  atbIds?: string;
  tdIds?: string;
} = {}) {
  const dbWrites: string[] = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      if (/\bDELETE\b|\bINSERT\b|\bUPDATE\b/i.test(sql)) dbWrites.push(sql);
      return {
        all: vi.fn(async () => ({results: [row()]})),
        bind: vi.fn(() => ({run: vi.fn(async () => ({success: true}))})),
        run: vi.fn(async () => ({success: true})),
      };
    }),
  };
  const requests: {url: string; method: string}[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({url, method});
    if (method !== 'GET') throw new Error(`Unexpected mutation request: ${method} ${url}`);
    return new Response(JSON.stringify({transactions}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  }));
  const env = {
    DB: db,
    LUNCHMONEY_API_KEY: 'TEST_ONLY',
    INTERAC_ATB_ACCOUNT_IDS: options.atbIds ?? '10',
    INTERAC_TD_ACCOUNT_IDS: options.tdIds ?? '20',
  } as unknown as Env;
  return {env, requests, dbWrites};
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Interac Worker integration - dry-run safety', () => {
  it('proposes a unique eligible TD match and never writes to Lunch Money or D1', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const {env, requests, dbWrites} = harness([tdTransaction()]);
    await processActions(env);
    expect(log.mock.calls.some(args => String(args[0]).includes('proposed transaction 101'))).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(dbWrites).toHaveLength(0);
  });

  it('does not match the same transfer against a TD account outside the allowlist', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const {env, requests, dbWrites} = harness([tdTransaction({account_id: 99})]);
    await processActions(env);
    expect(log.mock.calls.some(args => String(args[0]).includes('none (0 candidates)'))).toBe(true);
    expect(requests.every(r => r.method === 'GET')).toBe(true);
    expect(dbWrites).toHaveLength(0);
  });

  it('fails closed when an account allowlist is absent', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const {env, requests, dbWrites} = harness([tdTransaction()], {tdIds: ''});
    await processActions(env);
    expect(log.mock.calls.some(args => String(args[0]).includes('account allowlists not configured'))).toBe(true);
    expect(requests.every(r => r.method === 'GET')).toBe(true);
    expect(dbWrites).toHaveLength(0);
  });

  it('holds ambiguous transfers without selecting one', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const {env, requests, dbWrites} = harness([
      tdTransaction(),
      tdTransaction({id: 102}),
    ]);
    await processActions(env);
    expect(log.mock.calls.some(args => String(args[0]).includes('ambiguous (2 candidates)'))).toBe(true);
    expect(requests.every(r => r.method === 'GET')).toBe(true);
    expect(dbWrites).toHaveLength(0);
  });

  it('does not enrich reviewed transactions, existing notes or recurring matches', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const {env, dbWrites} = harness([
      tdTransaction({id: 101, status: 'cleared'}),
      tdTransaction({id: 102, notes: 'Already annotated'}),
      tdTransaction({id: 103, recurring_id: 123}),
    ]);
    await processActions(env);
    expect(log.mock.calls.some(args => String(args[0]).includes('none (0 candidates)'))).toBe(true);
    expect(dbWrites).toHaveLength(0);
  });
});
