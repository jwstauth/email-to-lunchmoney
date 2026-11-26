import { format, subDays } from 'date-fns';

import type { LunchMoneyAction, LunchMoneyActionRow } from './types';
import { matchInteracTransfer } from './processors/interac/match';

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
      // PHASE 4: Observation only. Never issues a Lunch Money PUT.
      // Account mapping must be configured before matching.
      const config = env as Env & {
        INTERAC_ACCOUNT_MAP?: string;
      };

      let accountMap: Record<string, number[]>;

      try {
        const parsed: unknown = JSON.parse(config.INTERAC_ACCOUNT_MAP ?? '');

        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          !Object.values(parsed).every(
            ids =>
              Array.isArray(ids) &&
              ids.length > 0 &&
              ids.every(id => Number.isSafeInteger(id) && id > 0),
          )
        ) {
          throw new Error('Invalid account mapping');
        }

        accountMap = parsed as Record<string, number[]>;
      } catch {
        console.log(
          `Interac dry-run action ${actionRow.id}: invalid or missing account mapping`,
        );
        continue;
      }

      const institution = action.transfer.institution.trim().toLowerCase();

      const configuredEntry = Object.entries(accountMap).find(
        ([name]) => name.trim().toLowerCase() === institution,
      );

      if (!configuredEntry) {
        console.log(
          `Interac dry-run action ${actionRow.id}: institution not configured`,
        );
        continue;
      }

      const ids = new Set(configuredEntry[1]);

      const scopedTransactions = txnsResp.transactions.filter(
        (txn: any) =>
          typeof txn.plaid_account_id === 'number' &&
          ids.has(txn.plaid_account_id) &&
          !assignedTransactions.includes(txn.id),
      );

      const result = matchInteracTransfer(
        action.transfer,
        scopedTransactions,
      );


      if (result.kind !== 'matched') {
        console.log(
          `Interac action ${actionRow.id}: ${result.kind} (${result.candidates} candidates)`,
        );
        continue;
      }

      const transactionId = result.value.transaction.id;
      const mode = (env as Env & { INTERAC_MODE?: string }).INTERAC_MODE;

      // Keep the existing observation-only behaviour.
      if (mode !== 'live') {
        console.log(
          `Interac dry-run action ${actionRow.id}: proposed transaction ${transactionId}`,
        );
        continue;
      }

      // Live mode: use the same update/cleanup pattern as Amazon and Apple.
      try {
        const transaction = {
          id: transactionId,
          notes: result.value.note,
          ...(result.value.payee === undefined
            ? {}
            : { payee: result.value.payee }),
          status: 'uncleared',
        };

        await lunchMoneyApi(env, `/transactions/${transactionId}`, {
          method: 'PUT',
          body: JSON.stringify({ transaction }),
        });

        assignedTransactions.push(transactionId);
        processedActionIds.push(actionRow.id);

        console.log(
          `Successfully processed Interac action ${actionRow.id} for transaction ${transactionId}`,
        );
      } catch (error) {
        console.error(
          `Failed to process Interac action ${actionRow.id}:`,
          error,
        );
      }

      continue;

    }


    // Uber receipts require a unique amount/payee/date match. Banking
    // posting dates can lag the actual trip/order by a few days.
    const isUberReceipt = actionRow.source === 'uber-ride' || actionRow.source === 'uber-eats';
    const permittedPayees = action.match.expectedPayees ?? [action.match.expectedPayee];
    const candidates = [...txnsResp.transactions]
      .reverse()
      .filter((txn: any) => {
        if (assignedTransactions.includes(txn.id) || hasNote(txn.notes)) { return false; }
        if (!permittedPayees.some(payee => payee.toLowerCase() === String(txn.payee).toLowerCase())) { return false; }
        if (txn.amount !== (action.match.expectedTotal / 100).toFixed(4)) { return false; }
        if (action.match.expectedDate) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(txn.date)) { return false; }
          const serviceDate = Date.parse(`${action.match.expectedDate}T00:00:00Z`);
          const postingDate = Date.parse(`${txn.date}T00:00:00Z`);
          if (!Number.isFinite(serviceDate) || !Number.isFinite(postingDate)) { return false; }
          const dayDifference = Math.round((postingDate - serviceDate) / 86400000);
          if (dayDifference < -1 || dayDifference > 3) { return false; }
        }
        return true;
      });

    if (isUberReceipt && candidates.length !== 1) {
      console.log(`Uber action ${actionRow.id}: ${candidates.length} eligible candidates; leaving unmatched`);
      continue;
    }
    const matchingTransaction = candidates[0];

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
          ...(action.payee === undefined ? {} : { payee: action.payee }),
          status: action.markReviewed ? 'cleared' : 'uncleared',
        };

        await lunchMoneyApi(env, `/transactions/${matchingTransaction.id}`, {
          method: 'PUT',
          body: JSON.stringify({ transaction }),
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
          body: JSON.stringify({ split }),
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
