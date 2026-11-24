import {addDays, differenceInMinutes, format, isBefore, parse} from 'date-fns';
import {convert as htmlToText} from 'html-to-text';
import type {Email} from 'postal-mime';

import type {EmailProcessor, LunchMoneyMatch, LunchMoneyUpdate} from 'src/types';
import {receiptDate, receiptField, receiptTotal} from 'src/processors/uber-receipt';

/**
 * Matches ride events with time and address on the same line
 * Example: "7:50 AM1-chōme-8-8 Tomigaya, Shibuya, Tokyo"
 */
const UBER_EVENTS_REGEX = /^(\d{1,2}:\d{2}\s*(?:AM|PM))(.+?)$/gm;

/**
 * Matches the total cost in USD
 * Example: "Total$36.80"
 */
const UBER_TOTAL_COST_REGEX = /^Total\$(\d+(?:,\d{3})*\.\d{2})$/m;

function process(email: Email) {
  const html = email.html ?? '';
  const modernTotal = receiptTotal(html);
  const modernPickup = receiptField(html, 'address_point_0_address');
  const modernDropoff = receiptField(html, 'address_point_1_address');
  const modernPickupTime = receiptField(html, 'address_point_0_time');
  const modernDropoffTime = receiptField(html, 'address_point_1_time');

  if (modernTotal !== null && modernPickup && modernDropoff && modernPickupTime && modernDropoffTime) {
    const parseTime = (value: string) => {
      const parts = value.match(/^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i);
      if (!parts) {return new Date(NaN);}
      const hours = Number(parts[1]) % 12 + (parts[3].toLowerCase() === 'p' ? 12 : 0);
      return new Date(2026, 0, 1, hours, Number(parts[2]));
    };
    const start = parseTime(modernPickupTime);
    let end = parseTime(modernDropoffTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error('Invalid Uber trip time');
    }
    if (isBefore(end, start)) {end = addDays(end, 1);}
    const note = `${modernPickup} → ${modernDropoff} [${format(start, 'HH:mm')}, ${differenceInMinutes(end, start)}m]`;
    const match: LunchMoneyMatch = {
      expectedPayee: 'Uber',
      expectedTotal: modernTotal,
      ...(receiptDate(html) ? {expectedDate: receiptDate(html)!} : {}),
    };
    return Promise.resolve({type: 'update', match, note} satisfies LunchMoneyUpdate);
  }

  const emailText = htmlToText(html);

  const eventMatches = [...emailText.matchAll(UBER_EVENTS_REGEX)];
  const costMatch = emailText.match(UBER_TOTAL_COST_REGEX);

  if (eventMatches.length === 0) {
    throw new Error('Failed to match pickup / drop-off events');
  }
  if (costMatch === null) {
    throw new Error('Failed to match uber ride total cost');
  }

  // Take only first 2 matches (pickup and dropoff) - the email repeats them
  const events = eventMatches.slice(0, 2).map(match => {
    const time = match[1];
    const address = match[2].trim();
    const date = parse(time, 'h:mm a', new Date());

    return {date, address};
  });

  const start = events[0].date;
  let end = events[events.length - 1].date;

  if (isBefore(end, start)) {
    end = addDays(end, 1);
  }

  const formattedStart = format(start, 'HH:mm');
  const duration = differenceInMinutes(end, start);

  const amount = costMatch[1].replaceAll(',', '');
  const costInCents = Math.round(Number(amount) * 100);

  const eventPath = events.map(e => e.address).join(' → ');

  const note = `${eventPath} [${formattedStart}, ${duration}m]`;

  const match: LunchMoneyMatch = {
    expectedPayee: 'Uber',
    expectedTotal: costInCents,
  };

  const updateAction: LunchMoneyUpdate = {type: 'update', match, note};

  return Promise.resolve(updateAction);
}

function matchEmail(email: Email) {
  const {from, subject, html} = email;
  const isUber = Boolean(from?.address?.endsWith('uber.com'));
  const hasRideSubject = Boolean(subject?.match(/your .+ trip with uber/i));

  if (!isUber || !hasRideSubject) {
    return false;
  }

  // Exclude non-receipt emails (preliminary trip summaries)
  const emailText = htmlToText(html!);
  return !emailText.toLowerCase().includes('this is not');
}

export const uberRideProcessor: EmailProcessor = {
  identifier: 'uber-ride',
  matchEmail,
  process,
};
