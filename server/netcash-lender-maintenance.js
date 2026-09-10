import { runNetcashMaintenance as runCoreNetcashMaintenance } from './netcash-collection-engine.js';
import { runDebitOrderFlowMaintenance } from './debit-order-flow-engine.js';
import { authoriseNetcashBatch, syncBlockedAccounts, syncDebiCheckParticipatingBanks } from './netcash-lender-suite.js';
import { processNetcashStatementTransaction } from './netcash-full-reconciliation.js';
import { loadNetcashCredentials } from './provider-secrets.js';
import { dbSelect, dbUpdate } from './supabase-rest.js';

function isoDaysAgo(days){const d=new Date();d.setUTCDate(d.getUTCDate()-days);return d.toISOString().slice(0,10);}

async function processPreviouslyIgnoredStatementRows(){
  const entries=await dbSelect('netcash_statement_entries',{select:'*',processing_status:'in.(ignored,received)',order:'statement_date.asc',limit:500}).catch(()=>[]);
  let processed=0,reviewRequired=0,failed=0;
  for(const entry of entries||[]){
    const row={statementDate:entry.statement_date,transactionType:entry.transaction_type,transactionId:entry.transaction_id,description:entry.description,amount:Number(entry.amount||0),symbol:entry.symbol,vat:Number(entry.vat||0),extra1:entry.extra1,extra2:entry.extra2,extra3:entry.extra3,raw:entry.raw?.fields||[]};
    try{
      const result=await processNetcashStatementTransaction(row);const review=result?.status==='review_required';
      await dbUpdate('netcash_statement_entries',{id:`eq.${entry.id}`},{processing_status:review?'review_required':'processed',processing_message:review?String(result.reason||'Review required').slice(0,500):null,processed_at:new Date().toISOString()});
      if(review)reviewRequired+=1;else processed+=1;
    }catch(error){failed+=1;await dbUpdate('netcash_statement_entries',{id:`eq.${entry.id}`},{processing_status:'failed',processing_message:String(error.message||error).slice(0,500),processed_at:new Date().toISOString()}).catch(()=>{});}
  }
  return{examined:(entries||[]).length,processed,reviewRequired,failed};
}

async function autoAuthoriseLoadedDebitBatches(){
  const config=(await dbSelect('netcash_config',{select:'auto_batch_authorization_enabled,auto_batch_authorization_indemnity_confirmed',id:'eq.true',limit:1}))?.[0]||{};
  if(!config.auto_batch_authorization_enabled||!config.auto_batch_authorization_indemnity_confirmed)return{skipped:true,reason:'auto_authorisation_not_enabled'};
  const credentials=await loadNetcashCredentials();if(!credentials?.debitOrderServiceKey)return{skipped:true,reason:'debit_key_missing'};
  const rows=await dbSelect('netcash_collection_instructions',{select:'id,batch_name,batch_id,status,authorisation_status',status:'eq.submitted',authorisation_status:'eq.manual_required',batch_name:'not.is.null',limit:500}).catch(()=>[]);
  const batches=[...new Set((rows||[]).map(r=>r.batch_name).filter(Boolean))];let authorised=0,failed=0;
  for(const batchName of batches){
    try{const result=await authoriseNetcashBatch(credentials.debitOrderServiceKey,batchName);await dbUpdate('netcash_collection_instructions',{batch_name:`eq.${batchName}`,status:'eq.submitted'},{batch_id:result.batchId||null,authorisation_status:'authorised',status:'accepted',last_error:null,updated_at:new Date().toISOString()});authorised+=1;}
    catch(error){failed+=1;await dbUpdate('netcash_collection_instructions',{batch_name:`eq.${batchName}`,status:'eq.submitted'},{last_error:`Auto authorisation failed: ${String(error.message||error).slice(0,400)}`,updated_at:new Date().toISOString()}).catch(()=>{});}
  }
  return{batches:batches.length,authorised,failed};
}

export async function runNetcashLenderMaintenance(){
  const config=(await dbSelect('netcash_config',{select:'enabled,validation_status,debicheck_enabled',id:'eq.true',limit:1}))?.[0]||{};
  if(!config.enabled||config.validation_status!=='validated')return{skipped:true,reason:'netcash_disabled'};
  const core=await runCoreNetcashMaintenance();
  const fullStatement=await processPreviouslyIgnoredStatementRows();
  // Reconcile provider results first. The flow engine then reacts only to provider-confirmed unpaids.
  const debitOrderFlows=await runDebitOrderFlowMaintenance().catch(error=>({error:error.message||'Debit-order flow maintenance failed'}));
  const autoAuthorisation=await autoAuthoriseLoadedDebitBatches();
  const participatingBanks=config.debicheck_enabled?await syncDebiCheckParticipatingBanks().catch(error=>({error:error.message})):null;
  const blockedAccounts=await syncBlockedAccounts({startDate:isoDaysAgo(7),endDate:new Date().toISOString().slice(0,10)}).catch(error=>({error:error.message}));
  return{...core,fullStatement,debitOrderFlows,autoAuthorisation,participatingBanks,blockedAccounts};
}
