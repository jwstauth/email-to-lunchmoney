import {env} from 'cloudflare:test';
import PostalMime from 'postal-mime';
import {expect, test} from 'vitest';

import {uberRideProcessor} from '.';

const testCases = [
  {
    file: 'example-1',
    expected: {
      type: 'update',
      match: {expectedPayee: 'Uber', expectedTotal: 3680},
      note: '123 Test Street, New York, NY 10009-6925, US → 30 Test City, TS 12345 10023, US [19:30, 23m]',
    },
  },
  {
    file: 'example-2',
    expected: {
      type: 'update',
      match: {expectedPayee: 'Uber', expectedTotal: 2096},
      note: '123 Test Street, Test City, TS 12345 → 2600 Geneva Ave, Daly City, CA [18:38, 23m]',
    },
  },
];

test.for(testCases)('can process $file', async ({file, expected}) => {
  const emailFile = await import(`./fixtures/${file}.eml?raw`);
  const email = await PostalMime.parse(emailFile.default);
  const result = await uberRideProcessor.process(email, env);

  expect(result).toEqual(expected);
});

test.for(testCases)('does match $file', async ({file}) => {
  const emailFile = await import(`./fixtures/${file}.eml?raw`);
  const email = await PostalMime.parse(emailFile.default);
  expect(uberRideProcessor.matchEmail(email)).toBe(true);
});

const nonReceiptCases = ['not-receipt-1', 'not-receipt-2'];

test.for(nonReceiptCases)('does not match non-receipt emails: %s', async file => {
  const emailFile = await import(`./fixtures/${file}.eml?raw`);
  const email = await PostalMime.parse(emailFile.default);

  // Should not match preliminary trip summaries
  expect(uberRideProcessor.matchEmail(email)).toBe(false);
});

const novemberSamples = [
  {file: 'nov-2026-morning', total: 1698, note: '[REDACTED], Calgary, AB [REDACTED] [REDACTED], Canada → 200 8 Ave SW, Calgary, AB T2P 1B5, Canada [07:24, 9m]'},
  {file: 'nov-2026-evening', total: 1596, note: '140 9 Ave SW, Calgary, AB T2P 3H9, Canada → [REDACTED], Calgary, AB [REDACTED] [REDACTED], Canada [17:43, 10m]'},
];
test.for(novemberSamples)('parses newer Canadian receipt: $file', async ({file, total, note}) => {
  const fixture = await import(`./fixtures/${file}.eml?raw`);
  const email = await PostalMime.parse(fixture.default);
  expect(uberRideProcessor.matchEmail(email)).toBe(true);
  expect(await uberRideProcessor.process(email, env)).toEqual({
    type: 'update',
    match: {expectedPayee: 'Uber', expectedTotal: total, expectedDate: '2026-11-19'},
    note,
  });
});
