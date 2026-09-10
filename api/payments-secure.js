import paymentsHandler from './payments.js';
import { requireStaffSession } from '../server/supabase-rest.js';
import { sendError } from '../server/http.js';

const STAFF_ACTIONS = new Set(['admin_request','providers','select_provider']);

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim().toLowerCase();
  try {
    if (STAFF_ACTIONS.has(action)) {
      await requireStaffSession(req, ['owner','manager','collections']);
    }
    return await paymentsHandler(req, res);
  } catch (error) {
    return sendError(res, error, `Secure payment ${action || 'request'} failed`);
  }
}
