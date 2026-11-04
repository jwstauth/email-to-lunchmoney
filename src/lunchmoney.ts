import {format, subDays} from 'date-fns';

import type {LunchMoneyAction, LunchMoneyActionRow} from './types';
import {matchInteracTransfer} from './processors/interac/match';

const LOOKBACK_DAYS = 180;

async function lunchMoneyApi(env: Env, endpoint: string, options: RequestInit = {}) {
  const url = `https://dev.lunchmoney.app/v1${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.LUNCHMONEY_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`LunchMoney API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Record<string, any>;
}

function hasNote(note: string | null) {
  return note !== null && note !== '';
}

export async function processActions(env: Env) {
  const stmt = env.DB.prepare(
    'SELECT * FROM lunchmoney_actions ORDER BY date_created ASC',
  );
  const actionsResult = await stmt.all<LunchMoneyActionRow>();
  const actions = actionsResult.results;

  // bail if there's no pending actions to process
  if (actions.length === 0) {
    console.log('No pending actions to process');
    return;
  }

  console.log(`Got ${actions.length} pending actions`);

  const now = new Date();
  const twoWeeksAgo = subDays(now, LOOKBACK_DAYS);

  const params = new URLSearchParams({
    start_date: format(twoWeeksAgo, 'yyyy-MM-dd'),
    end_date: format(now, 'yyyy-MM-dd'),
    status: 'uncleared',
    pending: 'true',
  });

  const txnsResp = await lunchMoneyApi(env, `/transactions?${params}`);

  console.log(`Got ${txnsResp.transactions.length} Lunch Money Transactions`);

  // iterate through all actions and then use transactions.find to locate a
  // transaction that has a matching payee name to what's expected in the
  // action as well as matching amount
  const processedActionIds: number[] = [];

  // track which transactions we've already assigned
  const assignedTransactions: number[] = [];

  for (const actionRow of actions) {
    const action: LunchMoneyAction = JSON.parse(actionRow.action);

    if (action.type === 'interac') {
      // PHASE 3: Observation only. This branch NEVER issues a Lunch Money PUT.
      // Explicit account allowlists are mandatory even for matching previews.
      const config = env as Env & {
        INTERAC_ATB_ACCOUNT_IDS?: string;
        INTERAC_TD_ACCOUNT_IDS?: string;
      };
      const parseIds = (value: string | undefined): Set<number> =>
        new Set((value ?? '').split(',').map(v => v.trim())
          .filter(v => /^\d+$/.test(v)).map(Number));
      const atbIds = parseIds(config.INTERAC_ATB_ACCOUNT_IDS);
      const tdIds = parseIds(config.INTERAC_TD_ACCOUNT_IDS);
      if (!atbIds.size || !tdIds.size) {
        console.log(`Interac dry-run action ${actionRow.id}: account allowlists not configured`);
        continue;
      }
      const bank = /\bATB\b/i.test(action.transfer.institution) ? 'ATB' :
        /^TD\b/i.test(action.transfer.institution) ? 'TD' : null;
      const ids = bank === 'ATB' ? atbIds : bank === 'TD' ? tdIds : null;
      if (!ids) {
        console.log(`Interac dry-run action ${actionRow.id}: bank not configured`);
        continue;
      }
      const scopedTransactions = txnsResp.transactions.filter((txn: any) =>
        typeof txn.account_id === 'number' && ids.has(txn.account_id) &&
        !assignedTransactions.includes(txn.id),
      );
      const result = matchInteracTransfer(action.transfer, scopedTransactions);
      if (result.kind === 'matched') {
        // IDs only, not the names, messages or entire financial records.
        console.log(`Interac dry-run action ${actionRow.id}: proposed transaction ${result.value.transaction.id}`);
      } else {
        console.log(`Interac dry-run action ${actionRow.id}: ${result.kind} (${result.candidates} candidates)`);
      }
      // Keep the action queued for later inspection. It is not marked processed.
      continue;
    }

    // Find matching transaction by payee name. Look for newest transactions
    // first, since we're processing actions in order of newest to oldest
    const matchingTransaction = txnsResp.transactions
      .reverse()
      .find(
        (txn: any) =>
          !assignedTransactions.includes(txn.id) &&
          !hasNote(txn.notes) &&
          txn.payee === action.match.expectedPayee &&
          txn.amount === (action.match.expectedTotal / 100).toFixed(4),
      );

    // if we can't find the transaction skip it
    if (matchingTransaction === undefined) {
      console.log(`No matching transaction found for action ${actionRow.id}`);
      continue;
    }

    console.log(`Found matching transaction for action ${actionRow.id}`, {
      matchingTransaction,
      actionRow,
    });

    // In a try catch try to process the lunch money action with the found
    // transaction. Either `update` which will just set the note, or `split`
    // which spits the transaction and sets the note from each split
    try {
      if (action.type === 'update') {
        const transaction = {
          id: matchingTransaction.id,
          notes: action.note,
          ...(action.payee === undefined ? {} : {payee: action.payee}),
          status: action.markReviewed ? 'cleared' : 'uncleared',
        };

        await lunchMoneyApi(env, `/transactions/${matchingTransaction.id}`, {
          method: 'PUT',
          body: JSON.stringify({transaction}),
        });
      }

      if (action.type === 'split') {
        // Convert split data from our format to API format
        const split = action.split.map(item => ({
          amount: (item.amount / 100).toFixed(2),
          notes: item.note,
          category_id: matchingTransaction.category_id,
          status: item.markReviewed ? 'cleared' : 'uncleared',
        }));

        await lunchMoneyApi(env, `/transactions/${matchingTransaction.id}`, {
          method: 'PUT',
          body: JSON.stringify({split}),
        });
      }

      assignedTransactions.push(matchingTransaction.id);

      // Record which lm action IDs have been processed so we can bulk remove them
      // from the database at the end
      processedActionIds.push(actionRow.id);
      console.log(`Successfully processed action ${actionRow.id}`);
    } catch (error) {
      console.error(`Failed to process action ${actionRow.id}:`, error);
    }
  }

  // Bulk remove processed actions
  if (processedActionIds.length > 0) {
    const placeholders = processedActionIds.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM lunchmoney_actions WHERE id IN (${placeholders})`)
      .bind(...processedActionIds)
      .run();
    console.log(`Removed ${processedActionIds.length} processed actions from database`);
  }
}
