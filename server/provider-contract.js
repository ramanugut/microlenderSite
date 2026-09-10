import { HttpError } from './http.js';

export const PROVIDER_CAPABILITIES = Object.freeze({
  PAYMENT_REQUEST: 'payment_request',
  CLIENT_CHECKOUT: 'client_checkout',
  RETURN_VERIFICATION: 'return_verification',
  EARLY_SETTLEMENT: 'early_settlement',
  AUTOMATIC_REMINDERS: 'automatic_reminders',
  MANDATE: 'mandate',
  REALTIME_MANDATE: 'realtime_mandate',
  DELAYED_MANDATE: 'delayed_mandate',
  MANDATE_AMENDMENT: 'mandate_amendment',
  REGISTERED_MANDATE: 'registered_mandate',
  DEBIT_ORDER: 'debit_order',
  SAME_DAY_EFT: 'same_day_eft',
  TWO_DAY_EFT: 'two_day_eft',
  CARD_DEBIT_ORDER: 'card_debit_order',
  AVS: 'avs',
  BULK_AVS: 'bulk_avs',
  ID_VALIDATION: 'id_validation',
  ID_VERIFICATION: 'id_verification',
  PAYOUT: 'payout',
  RTC_PAYOUT: 'rtc_payout',
  PAYOUT_PROOF: 'payout_proof',
  ACCOUNT_BALANCE: 'account_balance',
  ACCOUNT_LIMITS: 'account_limits',
  ECOMMERCE: 'ecommerce',
  QR_PAYMENT: 'qr_payment',
  SUBSCRIPTIONS: 'subscriptions',
  REFUNDS: 'refunds',
  CARD_TOKENIZATION: 'card_tokenization',
  AUTOMATIC_COLLECTION: 'automatic_collection',
  AUTO_BATCH_AUTHORISATION: 'auto_batch_authorisation',
  BLOCKED_ACCOUNTS: 'blocked_accounts',
  RECONCILIATION: 'reconciliation',
  BULK_STATEMENT: 'bulk_statement'
});

export function defineProvider(provider) {
  if (!provider || !/^[a-z0-9_]{2,40}$/.test(String(provider.id || ''))) {
    throw new Error('A provider must have a stable lowercase id.');
  }
  if (!provider.name || !Array.isArray(provider.capabilities)) throw new Error(`Provider ${provider.id} is missing metadata.`);
  const uniqueCapabilities = [...new Set(provider.capabilities)];
  return Object.freeze({ ...provider, capabilities:Object.freeze(uniqueCapabilities) });
}

export function providerSupports(provider, capability) {
  return Boolean(provider?.capabilities?.includes(capability));
}

export function requireProviderCapability(provider, capability) {
  if (!providerSupports(provider, capability)) {
    throw new HttpError(409, `${provider?.name || 'The selected provider'} does not support ${String(capability).replaceAll('_',' ')}.`, 'provider_capability_not_supported');
  }
}
