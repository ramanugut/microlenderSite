import { defineProvider, PROVIDER_CAPABILITIES } from '../provider-contract.js';
import { startCustomProviderPayment, verifyCustomProviderPayment, validateCustomProviderConnection, customProviderSettings } from '../custom-payment-provider.js';
import { HttpError } from '../http.js';

export const customHttpProvider=defineProvider({
  id:'custom_http',name:'Custom payment provider',
  capabilities:[PROVIDER_CAPABILITIES.PAYMENT_REQUEST,PROVIDER_CAPABILITIES.CLIENT_CHECKOUT,PROVIDER_CAPABILITIES.RETURN_VERIFICATION,PROVIDER_CAPABILITIES.EARLY_SETTLEMENT],
  async getDisplayName(){const{config}=await customProviderSettings();return config?.display_name||'Custom payment provider';},
  async readiness(){const{config,credentials}=await customProviderSettings();return{ready:Boolean(config?.enabled&&config.validation_status==='validated'&&config.base_url),enabled:Boolean(config?.enabled),validationStatus:config?.validation_status||'not_configured',credentialsConfigured:Boolean(credentials)};},
  async assertReady(){const state=await this.readiness();if(!state.ready)throw new HttpError(409,'The custom payment provider is not enabled and validated.','custom_provider_not_ready');return validateCustomProviderConnection();},
  async startClientPayment({loanId,scheduleId,paymentType,user,req}){return startCustomProviderPayment({loanId,scheduleId,paymentType,source:'client',userId:user.id,req});},
  async sendAdminPaymentRequest({loanId,scheduleId,paymentType,initiatedBy,req}){return startCustomProviderPayment({loanId,scheduleId,paymentType,source:'admin',initiatedBy,req});},
  async verifyClientReturn({reference,user}){return verifyCustomProviderPayment({reference,user});}
});
