import { setupNetcashLoan } from './netcash-loan-setup.js';
import { ensureNetcashAvsForLoan } from './netcash-avs.js';
import { dbSelect } from './supabase-rest.js';

export async function bootstrapMissingWebsiteMandates(limit=50){
  const configRows=await dbSelect('netcash_config',{select:'enabled,validation_status,website_default_collection_stream,website_debicheck_auth_mode,avs_enabled,require_avs_before_mandate',id:'eq.true',limit:1});
  const config=configRows?.[0];
  if(!config?.enabled||config.validation_status!=='validated')return{skipped:true,reason:'netcash_disabled'};
  const loans=await dbSelect('loans',{
    select:'id,application_id,status,outstanding_balance,collection_method,netcash_collection_stream',
    application_id:'not.is.null',status:'in.(active,overdue)',collection_method:'eq.debit_order',order:'created_at.asc',limit
  });
  if(!loans?.length)return{checked:0,created:0,failed:0,avsChecked:0};
  const loanIds=loans.map(row=>row.id);
  const contracts=await dbSelect('netcash_contracts',{select:'loan_id',loan_id:`in.(${loanIds.join(',')})`}).catch(()=>[]);
  const withContract=new Set((contracts||[]).map(row=>row.loan_id));
  let created=0;let failed=0;let avsChecked=0;
  for(const loan of loans){
    if(withContract.has(loan.id)||Number(loan.outstanding_balance)<=0)continue;
    try{
      const avs=await ensureNetcashAvsForLoan(loan.id);
      if(!avs?.skipped)avsChecked+=1;
      const result=await setupNetcashLoan({loanId:loan.id,stream:null,authMode:null,staffId:null});
      if(!result.skipped)created+=1;
    }catch(error){
      failed+=1;
      console.error('Netcash website mandate bootstrap failed',{loanId:loan.id,message:error.message});
    }
  }
  return{checked:loans.length,created,failed,avsChecked};
}
