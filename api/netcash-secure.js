import netcashHandler from './netcash.js';
import { HttpError, sendError } from '../server/http.js';

const CLIENT_OR_CALLBACK_ACTIONS = new Set([
  'request',
  'notify',
  'debicheck_postback',
  'emandate_postback',
  'card_token_return',
  'bulk_statement_ingest'
]);

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim().toLowerCase();
  try {
    if (!CLIENT_OR_CALLBACK_ACTIONS.has(action)) {
      throw new HttpError(404, 'Unknown client Netcash action.', 'invalid_netcash_action');
    }
    return await netcashHandler(req, res);
  } catch (error) {
    return sendError(res, error, `Secure client Netcash ${action || 'request'} failed`);
  }
}
