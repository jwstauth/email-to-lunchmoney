import type { Email } from 'postal-mime';
import type { EmailProcessor, LunchMoneyMatch, LunchMoneyUpdate } from 'src/types';
import { receiptDate, receiptField, receiptTotal } from 'src/processors/uber-receipt';

function matchEmail(email: Email): boolean {
  return Boolean(
    email.from?.address?.toLowerCase().endsWith('@uber.com') &&
    /your .+ order with uber eats/i.test(email.subject ?? '') &&
    email.html,
  );
}

async function process(email: Email): Promise<LunchMoneyUpdate> {
  const html = email.html ?? '';
  const total = receiptTotal(html);
  const subtitle = receiptField(html, 'header_sub_message');
  const restaurant = subtitle?.match(/(?:receipt|order) for (.+?)[.]?$/i)?.[1]?.replace(/\.$/, '').trim();
  const date = receiptDate(html);
  if (total === null || !restaurant || !date) {
    throw new Error('Missing total, restaurant or date on Uber Eats receipt');
  }
  const match: LunchMoneyMatch = {
    expectedPayee: 'Uber Eats',
    expectedTotal: total,
    expectedDate: date,
  };
  return {
    type: 'update',
    match,
    payee: restaurant,
    note: `Uber Eats order from ${restaurant}`,
  };
}

export const uberEatsProcessor: EmailProcessor = {
  identifier: 'uber-eats',
  matchEmail,
  process,
};
