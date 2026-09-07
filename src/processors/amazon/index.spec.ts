import {env} from 'cloudflare:test';
import PostalMime from 'postal-mime';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import fixture2Email from './fixtures/example-2.eml?raw';
import fixtureEmail from './fixtures/example.eml?raw';
import shippedFixtureEmail from './fixtures/shipped-example.eml?raw';
import fixtureOrder from './fixtures/example.json';
import fixtureEmailText from './fixtures/example.txt';
import {amazonProcessor, computeItemAdjustments, extractOrderBlock, extractOrderBlocks} from './index';
import * as prompt from './prompt';

const extractOrderSpy = vi.spyOn(prompt, 'extractOrder');

describe('Amazon order EmailProcessor', () => {
  beforeEach(() => {
    extractOrderSpy.mockReturnValue(Promise.resolve(fixtureOrder));
  });

  it('matches amazon order emails', async () => {
    const email = await PostalMime.parse(fixtureEmail);
    expect(amazonProcessor.matchEmail(email)).toBe(true);
  });

  it('matches amazon shipped emails', async () => {
    const email = await PostalMime.parse(fixtureEmail);
  
    email.subject = 'Shipped: Test order';
  
    expect(amazonProcessor.matchEmail(email)).toBe(true);
  });

  it('processes and creates a LunchMoneyAction for amazon orders', async () => {
    const email = await PostalMime.parse(fixtureEmail);

    const result = await amazonProcessor.process(email, env);

    expect(extractOrderSpy).toHaveBeenCalled();

    expect(result).toEqual({
      match: {expectedPayee: 'Amazon', expectedTotal: 4495},
      type: 'split',
      sourceId: '114-0833187-7581859',
      sourceEvent: 'ordered',
      split: [
        {
          note: 'Brushed Nickel Faucet (114-0833187-7581859)',
          amount: 2645,
        },
        {note: 'Nickel Sink Drain (114-0833187-7581859)', amount: 1850},
      ],
    });
  });

  it('includes item quantity in split amounts and notes for multi-item orders', async () => {
    extractOrderSpy.mockResolvedValue({
      orderId: '111-2222222-3333333',
      totalCostCents: 3700,
      orderItems: [
        {
          name: 'Item A',
          shortName: 'Item A',
          priceEachCents: 1000,
          quantity: 2,
        },
        {
          name: 'Item B',
          shortName: 'Item B',
          priceEachCents: 500,
          quantity: 3,
        },
      ],
    });

    const email = await PostalMime.parse(fixtureEmail);
    const result = await amazonProcessor.process(email, env);

    expect(result).toEqual({
      match: {expectedPayee: 'Amazon', expectedTotal: 3700},
      type: 'split',
      sourceId: '111-2222222-3333333',
      sourceEvent: 'ordered',
      split: [
        {
          note: 'Item A [x2] (111-2222222-3333333)',
          amount: 2114,
        },
        {
          note: 'Item B [x3] (111-2222222-3333333)',
          amount: 1586,
        },
      ],
    });
  });

  it('processes amazon shipped emails', async () => {
    const email = await PostalMime.parse(shippedFixtureEmail);
  
    extractOrderSpy.mockResolvedValue({
      orderId: '702-0000000-0000000',
      totalCostCents: 22049,
      orderItems: [
        {
          name: 'Momcozy M5 Smart Hands-Free Wearable Breast Pump (Cozy Red, 2 Count)',
          shortName: 'Momcozy M5 Breast Pump',
          priceEachCents: 20999,
          quantity: 1,
        },
      ],
    });
  
    const result = await amazonProcessor.process(email, env);
  
    expect(amazonProcessor.matchEmail(email)).toBe(true);
  
    expect(result).toEqual({
      match: {
        expectedPayee: 'Amazon',
        expectedTotal: 22049,
      },
      type: 'update',
      sourceId: '702-0000000-0000000',
      sourceEvent: 'shipped',
      note: 'Momcozy M5 Breast Pump (702-0000000-0000000)',
    });
  });

  it('removes stale ordered actions when a shipped email arrives', async () => {
    await env.DB.prepare(
      'INSERT INTO lunchmoney_actions (source, action) VALUES (?, ?)',
    )
      .bind(
        'amazon',
        JSON.stringify({
          type: 'update',
          sourceId: '702-0000000-0000000',
          sourceEvent: 'ordered',
          match: {
            expectedPayee: 'Amazon',
            expectedTotal: 22049,
          },
          note: 'Old ordered action',
        }),
      )
      .run();
  
    await env.DB.prepare(
      'INSERT INTO lunchmoney_actions (source, action) VALUES (?, ?)',
    )
      .bind(
        'amazon',
        JSON.stringify({
          type: 'update',
          sourceId: '702-0000000-0000000',
          sourceEvent: 'shipped',
          match: {
            expectedPayee: 'Amazon',
            expectedTotal: 1000,
          },
          note: 'Existing shipped action',
        }),
      )
      .run();
  
    await env.DB.prepare(
      'INSERT INTO lunchmoney_actions (source, action) VALUES (?, ?)',
    )
      .bind(
        'amazon',
        JSON.stringify({
          type: 'update',
          sourceId: '111-2222222-3333333',
          sourceEvent: 'ordered',
          match: {
            expectedPayee: 'Amazon',
            expectedTotal: 5000,
          },
          note: 'Different order',
        }),
      )
      .run();
  
    const email = await PostalMime.parse(shippedFixtureEmail);

    extractOrderSpy.mockResolvedValue({
      orderId: '702-0000000-0000000',
      totalCostCents: 22049,
      orderItems: [
        {
          name: 'Momcozy M5 Smart Hands-Free Wearable Breast Pump',
          shortName: 'Momcozy M5 Breast Pump',
          priceEachCents: 20999,
          quantity: 1,
        },
      ],
    });
  
    await amazonProcessor.process(email, env);
  
    const {results} = await env.DB.prepare(
      'SELECT action FROM lunchmoney_actions WHERE source = ?',
    )
      .bind('amazon')
      .all<{action: string}>();
  
    const actions = results.map(row => JSON.parse(row.action));
  
    expect(
      actions.some(
        action =>
          action.sourceId === '702-0000000-0000000' &&
          action.sourceEvent === 'ordered',
      ),
    ).toBe(false);
  
    expect(
      actions.some(
        action =>
          action.sourceId === '702-0000000-0000000' &&
          action.sourceEvent === 'shipped',
      ),
    ).toBe(true);
  
    expect(
      actions.some(action => action.sourceId === '111-2222222-3333333'),
    ).toBe(true);
  });

  it('falls back to an order note when extraction returns no order items', async () => {
    extractOrderSpy.mockResolvedValue({
      orderId: '111-2222222-3333333',
      totalCostCents: 1000,
      orderItems: [],
    });

    const email = await PostalMime.parse(fixtureEmail);

    await expect(amazonProcessor.process(email, env)).resolves.toEqual({
      match: {expectedPayee: 'Amazon', expectedTotal: 1000},
      type: 'update',
      sourceId: '111-2222222-3333333',
      sourceEvent: 'ordered',
      note: '[No products in email] (111-2222222-3333333)',
    });
  });
});

describe('extractOrderBlock', () => {
  it('extracts order block from Amazon email text', () => {
    const result = extractOrderBlock(fixtureEmailText);

    expect(result).toContain('Order #');
    expect(result).toContain('114-0833187-7581859');
    expect(result).toContain('Bathroom Faucet Brushed Nickel');
    expect(result).toContain('Bathroom Sink Drain Without Overflow');
    expect(result).toContain('24.29 USD');
    expect(result).toContain('16.99 USD');
    expect(result).toContain('Total');
    expect(result).toContain('44.95 USD');
    expect(result).not.toContain('©2025 Amazon.com');
  });

  it('returns null when no order block found', () => {
    const invalidEmailText = 'This is not an Amazon order email';
    const result = extractOrderBlock(invalidEmailText);

    expect(result).toBeNull();
  });

  it('returns null when order start found but no footer', () => {
    const incompleteEmailText =
      'Order #\n114-0833187-7581859\nSome content without footer';
    const result = extractOrderBlock(incompleteEmailText);

    expect(result).toBeNull();
  });

  it('extracts order block from example-2 email with 2026 footer', async () => {
    const email = await PostalMime.parse(fixture2Email);
    const result = extractOrderBlock(email.text ?? '');

    expect(result).not.toBeNull();
    expect(result).toContain('Order #');
  });

  it('extracts multiple order blocks from a single Amazon email', () => {
  const emailText = `
Order #
702-9996109-6145035

* Sudocrem
  Quantity: 1
  14.49 CAD

* Frida Baby Spatula
  Quantity: 1
  12.99 CAD

Total
28.85 CAD

Arriving tomorrow

Order #
702-5061481-2939420

* Bambo Nature Baby Diapers
  Quantity: 1
  18.79 CAD

* Bearmoss Muslin Crib Sheets
  Quantity: 1
  31.66 CAD

Total
52.97 CAD

©2026 Amazon.ca
`;

  const results = extractOrderBlocks(emailText);

  expect(results).toHaveLength(2);

  expect(results[0]).toContain('702-9996109-6145035');
  expect(results[0]).toContain('28.85 CAD');
  expect(results[0]).not.toContain('702-5061481-2939420');

  expect(results[1]).toContain('702-5061481-2939420');
  expect(results[1]).toContain('52.97 CAD');
});

});

describe('computeItemAdjustments', () => {
  const i = {
    name: 'Some product',
    shortName: 'Product',
  };

  it('computes adjustments for two items correctly', () => {
    const items = [
      {...i, priceEachCents: 2429, quantity: 1},
      {...i, priceEachCents: 1699, quantity: 1},
    ];
    const total = 4495; // subtotal: 4128, adjustment: 367

    const adjustments = computeItemAdjustments(items, total);
    expect(adjustments).toEqual([216, 151]);
  });

  it('computes zero adjustments correctly', () => {
    const items = [
      {...i, priceEachCents: 1000, quantity: 1},
      {...i, priceEachCents: 1500, quantity: 1},
    ];
    const total = 2500;

    const adjustments = computeItemAdjustments(items, total);
    expect(adjustments).toEqual([0, 0]);
  });

  it('handles total less than subtotal as a negative adjustment', () => {
    const items = [
      {
        name: 'Item',
        quantity: 1,
        priceEachCents: 1000,
      },
    ];
    const total = 900;

    expect(computeItemAdjustments(items, total)).toEqual([-100]);
  });

  it('handles a negative adjustment when total is less than subtotal', () => {
    const items = [
      {
        name: 'Subscribe & Save Item',
        quantity: 1,
        priceEachCents: 12599,
      },
    ];

  expect(computeItemAdjustments(items, 12567)).toEqual([-32]);
});

  it('handles small adjustment split across identical items', () => {
    const items = Array.from({length: 5}, () => ({
      ...i,
      priceEachCents: 100,
      quantity: 1,
    }));
    const total = 505; // subtotal: 500, adjustment: 5

    const adjustments = computeItemAdjustments(items, total);
    expect(adjustments).toEqual([1, 1, 1, 1, 1]);
  });

  it('handles tricky rounding case with repeating decimals', () => {
    const items = [
      {...i, priceEachCents: 100, quantity: 1},
      {...i, priceEachCents: 200, quantity: 1},
    ];
    const total = 399; // subtotal: 300, adjustment: 99

    const adjustments = computeItemAdjustments(items, total);
    expect(adjustments).toEqual([33, 66]);
  });

  it('handles fractional adjustment with very similar items', () => {
    const items = [
      {...i, priceEachCents: 3333, quantity: 1},
      {...i, priceEachCents: 3333, quantity: 1},
      {...i, priceEachCents: 3334, quantity: 1},
    ];
    const total = 10503; // subtotal: 10000, adjustment: 503

    const adjustments = computeItemAdjustments(items, total);
    expect(adjustments).toEqual([168, 168, 167]);
  });

  it('allocates adjustment correctly when items differ greatly in price', () => {
    const items = [
      {...i, priceEachCents: 99, quantity: 1},
      {...i, priceEachCents: 19999, quantity: 1},
    ];
    const total = 21712; // subtotal: 20098, adjustment: 1614

    const adjustments = computeItemAdjustments(items, total);
    expect(adjustments).toEqual([8, 1606]);
  });

  it('distributes adjustment correctly across items with quantity > 1', () => {
    const items = [
      {...i, priceEachCents: 1000, quantity: 2},
      {...i, priceEachCents: 500, quantity: 3},
    ];
    const total = 3700; // subtotal: 3500, adjustment: 200

    const adjustments = computeItemAdjustments(items, total);
    expect(adjustments).toEqual([114, 86]); // 2000 gets 57.14%, 1500 gets 42.86% of 200
  });
});
