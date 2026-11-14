import { afterEach, describe, expect, it, vi } from 'vitest';

import { processActions } from './lunchmoney';
import type { LunchMoneyInterac, LunchMoneyActionRow } from './types';

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
    action: JSON.stringify({ type: 'interac', transfer }),
  };
}

function tdTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    plaid_account_id: 20,
    date: '2026-10-30',
    amount: '280.0000',
    payee: 'SEND E-TFR ***n4g',
    original_name: 'SEND E-TFR ***n4g',
    notes: null,
    status: 'uncleared',
    recurring_id: null,
    ...overrides,
  };
}


function harness(
  transactions: Record<string, unknown>[],
  options: {
    mode?: 'dry-run' | 'live';
    failPut?: boolean;
  } = {},
) {
  const dbWrites: string[] = [];

  const db = {
    prepare: vi.fn((sql: string) => {
      if (/\bDELETE\b|\bINSERT\b|\bUPDATE\b/i.test(sql)) {
        dbWrites.push(sql);
      }
      return {
        all: vi.fn(async () => ({ results: [row()] })),
        bind: vi.fn(() => ({
          run: vi.fn(async () => ({ success: true })),
        })),
        run: vi.fn(async () => ({ success: true })),
      };
    }),
  };

  const requests: {
    url: string;
    method: string;
    body?: string;
  }[] = [];

  vi.stubGlobal('fetch', vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    requests.push({
      url,
      method,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    if (method === 'GET') {
      return new Response(JSON.stringify({ transactions }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (method === 'PUT') {
      return new Response(
        JSON.stringify({ success: !options.failPut }),
        {
          status: options.failPut ? 500 : 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  }));

  const env = {
    DB: db,
    LUNCHMONEY_API_KEY: 'TEST_ONLY',
    INTERAC_MODE: options.mode ?? 'dry-run',
    INTERAC_ACCOUNT_MAP: JSON.stringify({
      'ATB Financial': [10],
      'TD Canada Trust': [20],
    }),
  } as unknown as Env;

  return { env, requests, dbWrites };
}


afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Interac Worker integration - dry-run safety', () => {
  it('proposes a unique eligible TD match and never writes to Lunch Money or D1', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { });
    const { env, requests, dbWrites } = harness([tdTransaction()]);
    await processActions(env);
    expect(log.mock.calls.some(args => String(args[0]).includes('proposed transaction 101'))).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(dbWrites).toHaveLength(0);
  });

  it('does not match the same transfer against a TD account outside the allowlist', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { });
    const { env, requests, dbWrites } = harness([tdTransaction({ plaid_account_id: 99 })]);
    await processActions(env);
    expect(log.mock.calls.some(args => String(args[0]).includes('none (0 candidates)'))).toBe(true);
    expect(requests.every(r => r.method === 'GET')).toBe(true);
    expect(dbWrites).toHaveLength(0);
  });



  it('fails closed when account mapping is missing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { });
    const { env, requests, dbWrites } = harness([tdTransaction()]);

    // Simulate missing Cloudflare configuration.
    delete (env as Env & { INTERAC_ACCOUNT_MAP?: string })
      .INTERAC_ACCOUNT_MAP;

    await processActions(env);

    expect(
      log.mock.calls.some(args =>
        String(args[0]).includes('invalid or missing account mapping'),
      ),
    ).toBe(true);

    expect(requests.every(r => r.method === 'GET')).toBe(true);
    expect(dbWrites).toHaveLength(0);
  });



  it('holds ambiguous transfers without selecting one', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { });
    const { env, requests, dbWrites } = harness([
      tdTransaction(),
      tdTransaction({ id: 102 }),
    ]);
    await processActions(env);
    expect(log.mock.calls.some(args => String(args[0]).includes('ambiguous (2 candidates)'))).toBe(true);
    expect(requests.every(r => r.method === 'GET')).toBe(true);
    expect(dbWrites).toHaveLength(0);
  });

  it('does not enrich reviewed transactions, existing notes or recurring matches', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { });
    const { env, dbWrites } = harness([
      tdTransaction({ id: 101, status: 'cleared' }),
      tdTransaction({ id: 102, notes: 'Already annotated' }),
      tdTransaction({ id: 103, recurring_id: 123 }),
    ]);
    await processActions(env);
    expect(log.mock.calls.some(args => String(args[0]).includes('none (0 candidates)'))).toBe(true);
    expect(dbWrites).toHaveLength(0);
  });
});


describe('Interac Worker integration - live updates', () => {
  it('updates an eligible transaction and removes its D1 action', async () => {
    const { env, requests, dbWrites } = harness(
      [tdTransaction()],
      { mode: 'live' },
    );

    await processActions(env);

    const put = requests.find(r => r.method === 'PUT');

    expect(put).toBeDefined();
    expect(put?.url).toContain('/transactions/101');

    const body = JSON.parse(put!.body!);

    expect(body.transaction).toEqual({
      id: 101,
      notes: 'week of Oct 26 | Interac recipient: MARYAM JARRAHI | Reference: C1Aame6Gdn4g',
      payee: 'MARYAM JARRAHI',
      status: 'uncleared',
    });

    expect(dbWrites).toHaveLength(1);
    expect(dbWrites[0]).toMatch(/\bDELETE\b/i);
  });

  it('preserves a manually renamed payee', async () => {
    const { env, requests, dbWrites } = harness(
      [tdTransaction({ payee: 'My custom payee' })],
      { mode: 'live' },
    );

    await processActions(env);

    const put = requests.find(r => r.method === 'PUT');

    expect(put).toBeDefined();

    const body = JSON.parse(put!.body!);

    expect(body.transaction.id).toBe(101);
    expect(body.transaction).not.toHaveProperty('payee');
    expect(body.transaction.status).toBe('uncleared');
    expect(body.transaction.notes).toContain('Interac recipient: MARYAM JARRAHI');

    expect(dbWrites).toHaveLength(1);
  });

  it('retains the D1 action if the Lunch Money update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { });

    const { env, requests, dbWrites } = harness(
      [tdTransaction()],
      { mode: 'live', failPut: true },
    );

    await processActions(env);

    expect(requests.some(r => r.method === 'PUT')).toBe(true);
    expect(dbWrites).toHaveLength(0);
  });

  it('does not update an ineligible transaction in live mode', async () => {
    const { env, requests, dbWrites } = harness(
      [
        tdTransaction({ id: 101, status: 'cleared' }),
        tdTransaction({ id: 102, notes: 'Existing note' }),
        tdTransaction({ id: 103, recurring_id: 123 }),
      ],
      { mode: 'live' },
    );

    await processActions(env);

    expect(requests.every(r => r.method === 'GET')).toBe(true);
    expect(dbWrites).toHaveLength(0);
  });
});
