import netcashHandler from './netcash.js';
import { requireStaffSession } from '../server/supabase-rest.js';
import { sendError } from '../server/http.js';

const PUBLIC_OR_CLIENT_ACTIONS = new Set([
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
    if (!PUBLIC_OR_CLIENT_ACTIONS.has(action)) {
      await requireStaffSession(req, ['owner','manager','collections','underwriter']);
    }
    return await netcashHandler(req, res);
  } catch (error) {
    return sendError(res, error, `Secure Netcash ${action || 'request'} failed`);
  }
}
