import type {Email} from 'postal-mime';
import type {EmailProcessor, LunchMoneyInterac} from '../../types';
import {matchesInteracEmail, parseInteracEmail} from './index';

/**
 * Disabled unless INTERAC_MODE=dry-run. The runner contains no Interac write path.
 * Do not apply Gmail labels until the project is ready for end-to-end validation.
 */
export const interacEmailProcessor: EmailProcessor = {
  identifier: 'interac',
  matchEmail: matchesInteracEmail,
  async process(email: Email, env: Env): Promise<LunchMoneyInterac | null> {
    const mode = (env as Env & {INTERAC_MODE?: string}).INTERAC_MODE;
    if (mode !== 'dry-run') return null;
    return {type: 'interac', transfer: parseInteracEmail(email)};
  },
};
