import { env } from 'cloudflare:test';
import PostalMime from 'postal-mime';
import { expect, test } from 'vitest';
import { uberEatsProcessor } from '.';
import { uberRideProcessor } from '../uber-ride';

const receipt = await import('./fixtures/nov-2026.eml?raw');
const email = await PostalMime.parse(receipt.default);

test('routes an Uber Eats email to Eats, not rides', () => {
  expect(uberEatsProcessor.matchEmail(email)).toBe(true);
  expect(uberRideProcessor.matchEmail(email)).toBe(false);
});

test('extracts final Eats total and restaurant', async () => {
  expect(await uberEatsProcessor.process(email, env)).toEqual({
    type: 'update',
    match: {
      expectedPayee: 'Uber Eats',
      expectedTotal: 11581,
      expectedDate: '2026-11-18',
    },
    payee: 'Synthetic Restaurant',
    note: 'Uber Eats order from Synthetic Restaurant',
  });
});
