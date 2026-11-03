import type { Email } from 'postal-mime';
import { describe, expect, test } from 'vitest';
import { matchesInteracEmail, parseInteracEmail } from './index';

const makeEmail = (subject: string, sender: string, name: string, text: string, date = '2026-10-30T17:24:00-06:00'): Email => ({
  from: { address: sender, name }, subject, text, date,
}) as Email;

const incoming = (person: string, amount: string, holder: string, bank: string, account: string,
  date: string, reference: string, message?: string) => makeEmail(
    `Interac e-Transfer: You've received $${amount} from ${person} and it has been automatically deposited.`,
    'notify@payments.interac.ca', person,
    `Hi ${holder},\nFunds Deposited!\n$${amount}\nYour funds have been automatically deposited into your account at ${bank}.\n${bank}\nAccount ending in ${account}\nTransfer Details\nDate:\n${date}\nReference Number:\n${reference}\nSent From:\n${person}\nAmount:\n$${amount} (CAD)\n${message === undefined ? '' : `Message:\n${message}\n`}FAQ`,
  );
const deposited = (person: string, amount: string, holder: string, bank: string, date: string,
  reference: string, message: string) => makeEmail(
    `e-Transfer: Your $${amount} transfer to ${person} has been successfully deposited.`,
    'catch@payments.interac.ca', bank,
    `Hi ${holder},\nYour transfer to ${person} was successfully deposited.\nThe $${amount} (CAD) you sent to ${person} has been successfully deposited.\nTransfer Details\nDate:\n${date}\nReference Number:\n${reference}\nMessage:\n${message}\nFAQ`,
  );
const accepted = (person: string, amount: string, holder: string, bank: string, date: string,
  reference: string, message: string) => makeEmail(
    `Interac e-Transfer: ${person} has accepted your transfer of $${amount}`,
    'catch@payments.interac.ca', bank,
    `Hi ${holder},\n${person} has accepted your transfer of\n$${amount}\nThe transfer you sent to ${person} for the amount of $${amount} (CAD) has been successfully deposited.\nTransfer Details\nDate:\n${date}\nReference Number:\n${reference}\nMessage:\n${message}\nFAQ`,
  );

describe('Interac parser — six supplied notification patterns', () => {
  const examples = [
    { email: incoming('Felicia Kelley', '1,950.00', 'JEREMY STAUTH', 'ATB Financial', '3100', 'Oct 1, 2026', 'C1AyD4exC2JK', 'Rent'), direction: 'incoming', cents: 195000, name: 'Felicia Kelley', date: '2026-10-01', message: 'Rent', suffix: '3100' },
    { email: deposited('ERIC NYLAND', '504.00', 'JEREMY STAUTH', 'ATB Financial', 'Oct 30, 2026', 'C1AXmCMaSj9f', 'INV 001150'), direction: 'outgoing', cents: 50400, name: 'ERIC NYLAND', date: '2026-10-30', message: 'INV 001150', suffix: null },
    { email: accepted('Alyssa Hayes', '1,444.50', 'JEREMY STAUTH', 'ATB Financial', 'July 1, 2026', 'CAaRpg2E', 'Trailer payment $1144.50 plus $500 damage deposit less $200 deposit already paid.'), direction: 'outgoing', cents: 144450, name: 'Alyssa Hayes', date: '2026-07-01', message: 'Trailer payment $1144.50 plus $500 damage deposit less $200 deposit already paid.', suffix: null },
    { email: deposited('MARYAM JARRAHI', '280.00', 'MARYAM STAUTH', 'TD Canada Trust', 'Oct 30, 2026', 'C1Aame6Gdn4g', 'week of Oct 26'), direction: 'outgoing', cents: 28000, name: 'MARYAM JARRAHI', date: '2026-10-30', message: 'week of Oct 26', suffix: null },
    { email: incoming('MOJTABA SHAFIEE', '151.00', 'MARYAM STAUTH', 'TD Canada Trust', '9755', 'Feb 17, 2026', 'C1ASjGMh6brR'), direction: 'incoming', cents: 15100, name: 'MOJTABA SHAFIEE', date: '2026-02-17', message: null, suffix: '9755' },
    { email: accepted('Jullyety da Costa Pires', '150.00', 'MARYAM STAUTH', 'TD Canada Trust', 'Aug 14, 2026', 'CAtn4emh', 'aug 13 (5hrs)'), direction: 'outgoing', cents: 15000, name: 'Jullyety da Costa Pires', date: '2026-08-14', message: 'aug 13 (5hrs)', suffix: null },
  ];
  test.each(examples)('$name — $date', ({ email, direction, cents, name, date, message, suffix }) => {
    expect(matchesInteracEmail(email)).toBe(true);
    expect(parseInteracEmail(email)).toMatchObject({
      direction, amountCents: cents, counterparty: name,
      transferDate: date, message, accountSuffix: suffix, currency: 'CAD',
    });
  });
});

test('rejects spoofed sender', () => {
  const email = deposited('ERIC NYLAND', '504.00', 'JEREMY STAUTH', 'ATB Financial', 'Oct 30, 2026', 'REF123', 'Invoice');
  email.from!.address = 'catch@payments.interac.ca.example.com';
  expect(matchesInteracEmail(email)).toBe(false);
  expect(() => parseInteracEmail(email)).toThrow();
});

test('rejects inconsistent confirmation amount', () => {
  const email = deposited('ERIC NYLAND', '504.00', 'JEREMY STAUTH', 'ATB Financial', 'Oct 30, 2026', 'REF123', 'Invoice');
  email.text = email.text!.replace('The $504.00', 'The $505.00');
  expect(() => parseInteracEmail(email)).toThrow(/amounts disagree/);
});

test('parses plain-text fallback from HTML', () => {
  const email = deposited('ERIC NYLAND', '504.00', 'JEREMY STAUTH', 'ATB Financial', 'Oct 30, 2026', 'REF123', 'Invoice');
  email.html = `<html><body><pre>${email.text}</pre></body></html>`;
  email.text = undefined;
  expect(parseInteracEmail(email).reference).toBe('REF123');
});
