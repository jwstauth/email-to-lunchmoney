import type {Email} from 'postal-mime';

import type {
  EmailProcessor,
  LunchMoneyAction,
  LunchMoneyMatch,
  LunchMoneySplit,
  LunchMoneyUpdate,
} from 'src/types';

import {extractOrder} from './prompt';
import type {AmazonOrder, AmazonOrderItem} from './types';

/**
 * Extracts the main order block from an Amazon plain text email.
 * It starts at the line containing "Order #" and ends before the footer.
 */
export function extractOrderBlocks(emailText: string): string[] {
  const orderStarts = [...emailText.matchAll(/^Order #\s*$/gim)];

  if (orderStarts.length === 0) {
    return [];
  }

  const footerMatch = emailText.match(/©\d{4} Amazon\.(?:com|ca)/i);
  if (!footerMatch || footerMatch.index === undefined) {
    return [];
  }

  const emailEnd = footerMatch.index;

  return orderStarts.map((match, index) => {
    const start = match.index ?? 0;
    const nextStart = orderStarts[index + 1]?.index ?? emailEnd;

    return emailText.slice(start, nextStart).trim();
  });
}

export function extractOrderBlock(emailText: string): string | null {
  return extractOrderBlocks(emailText)[0] ?? null;
}

/**
 * Computes the adjustment amount for each item in an order by proportionally
 * allocating the difference between the item subtotal and final order total.
 * This can represent tax, discounts, promotions, or other adjustments.
 * Works with cents (integers) to avoid floating-point precision issues.
 * Returns adjustment amounts in cents.
 */
export function computeItemAdjustments(items: AmazonOrderItem[], totalCents: number): number[] {
  const subtotalCents = items.reduce(
    (sum, item) => sum + item.priceEachCents * item.quantity,
    0,
  );

  const totalAdjustmentCents = totalCents - subtotalCents;

  if (totalAdjustmentCents === 0) {
    return items.map(() => 0);
  }

  // Calculate proportional adjustment for each item in cents
  const adjustmentCents = items.map(item => {
    const itemCostCents = item.priceEachCents * item.quantity;
    return Math.round((itemCostCents / subtotalCents) * totalAdjustmentCents);
  });

  // Adjust for rounding errors by adding/subtracting from the last item
  const calculatedTotalAdjustment = adjustmentCents.reduce((sum, adjustment) => sum + adjustment, 0);
  const difference = totalAdjustmentCents - calculatedTotalAdjustment;
  adjustmentCents[adjustmentCents.length - 1] += difference;

  return adjustmentCents;
}

function makeItemNote(order: AmazonOrder, item: AmazonOrderItem) {
  const quantity = item.quantity > 1 ? ` [x${item.quantity}]` : '';

  return `${item.shortName}${quantity} (${order.orderId})`;
}

function makeAction(
  order: AmazonOrder,
  sourceEvent: 'ordered' | 'shipped',
): LunchMoneyAction {
  if (order.orderItems.length === 0) {
    return {
      match: {
        expectedPayee: 'Amazon',
        expectedTotal: order.totalCostCents,
      },
      type: 'update',
      sourceId: order.orderId,
      sourceEvent,
      note: `[No products in email] (${order.orderId})`,
    };
  }

  const itemsAdjustments = computeItemAdjustments(order.orderItems, order.totalCostCents);

  const match: LunchMoneyMatch = {
    expectedPayee: 'Amazon',
    expectedTotal: order.totalCostCents,
  };

  if (order.orderItems.length > 1) {
    const splitAction: LunchMoneySplit = {
      match,
      type: 'split',
      sourceId: order.orderId,
      sourceEvent,
      split: order.orderItems.map((item, i) => ({
        note: makeItemNote(order, item),
        amount: item.priceEachCents * item.quantity + itemsAdjustments[i],
      })),
    };

    return splitAction;
  }

  const updateAction: LunchMoneyUpdate = {
    match,
    type: 'update',
    sourceId: order.orderId,
    sourceEvent,
    note: makeItemNote(order, order.orderItems[0]),
  };

  return updateAction;
}

async function removeStaleOrderedAction(orderId: string, env: Env) {
  const {results} = await env.DB.prepare(
    "SELECT id, action FROM lunchmoney_actions WHERE source = 'amazon'",
  ).all<{id: number; action: string}>();

  const staleIds = results
    .filter(row => {
      const action = JSON.parse(row.action) as LunchMoneyAction;

      return (
        action.sourceId === orderId &&
        action.sourceEvent === 'ordered'
      );
    })
    .map(row => row.id);

  for (const id of staleIds) {
    await env.DB.prepare(
      'DELETE FROM lunchmoney_actions WHERE id = ?',
    )
      .bind(id)
      .run();
  }
}

async function process(email: Email, env: Env) {
  const emailText = email.text ?? '';
  const sourceEvent = email.subject?.startsWith('Shipped')
    ? 'shipped'
    : 'ordered';
  const orderTexts = extractOrderBlocks(emailText);

  if (orderTexts.length === 0) {
    throw new Error('Failed to extract order blocks from amazon email');
  }

  const actions: LunchMoneyAction[] = [];

  for (const orderText of orderTexts) {
    const order = await extractOrder(orderText, env);

    console.log('Got order details from amazon email', {order});

    if (order.totalCostCents === 0) {
      console.info('Ignoring Amazon order with zero cost', {
        orderId: order.orderId,
      });
      continue;
    }

    if (sourceEvent === 'shipped') {
      await removeStaleOrderedAction(order.orderId, env);
    }

    actions.push(makeAction(order, sourceEvent));
  }

  if (actions.length === 0) {
    return null;
  }

  return actions.length === 1 ? actions[0] : actions;
}

function matchEmail(email: Email) {
  const {from, subject} = email;
  const address = from?.address ?? '';
  const isAmazonOrderEmail = subject?.startsWith('Ordered') || subject?.startsWith('Shipped');

  return (
    (address.endsWith('amazon.com') || address.endsWith('amazon.ca')) &&
    Boolean(isAmazonOrderEmail)
  );
}

export const amazonProcessor: EmailProcessor = {
  identifier: 'amazon',
  matchEmail,
  process,
};
