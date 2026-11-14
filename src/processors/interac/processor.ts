import type { Email } from 'postal-mime';
import type { EmailProcessor, LunchMoneyInterac } from '../../types';
import { matchesInteracEmail, parseInteracEmail } from './index';

/**
 * Disabled unless INTERAC_MODE=dry-run or INTERAC_MODE=live.
 * Both modes ingest emails; only live mode permits Lunch Money updates.
 */
export const interacEmailProcessor: EmailProcessor = {
  identifier: 'interac',
  matchEmail: matchesInteracEmail,
  async process(email: Email, env: Env): Promise<LunchMoneyInterac | null> {
    const mode = (env as Env & { INTERAC_MODE?: string }).INTERAC_MODE;
    if (mode !== 'dry-run' && mode !== 'live') return null;
    return { type: 'interac', transfer: parseInteracEmail(email) };
  },
};
