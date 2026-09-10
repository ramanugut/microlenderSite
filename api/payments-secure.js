import paymentsHandler from './payments.js';
import { HttpError, sendError } from '../server/http.js';

const CLIENT_ACTIONS = new Set(['quote','start','verify']);

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim().toLowerCase();
  try {
    if (!CLIENT_ACTIONS.has(action)) {
      throw new HttpError(404, 'Unknown client payment action.', 'invalid_payment_action');
    }
    return await paymentsHandler(req, res);
  } catch (error) {
    return sendError(res, error, `Secure client payment ${action || 'request'} failed`);
  }
}
