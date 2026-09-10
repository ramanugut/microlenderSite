import { HttpError } from './http.js';
import { sendCollectionReminder } from './customer-notifications.js';
import { dbInsert, dbRpc, dbSelect, dbUpdate, supabaseRequest } from './supabase-rest.js';

export function todayZA(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Johannesburg',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
export function addDays(value,days){const d=new Date(`${value}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function daysBetween(a,b){return Math.max(0,Math.floor((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000));}
function openAmount(row){return Math.max(0,Number(row.amount_due||0)-Number(row.amount_paid||0));}
async function insertEvent(body){try{return(await dbInsert('collection_events',body))?.[0]||null;}catch(error){if(error.databaseCode==='23505'||error.code==='23505')return null;throw error;}}

export async function collectionSettings(){const rows=await dbSelect('lender_settings',{select:'automatic_payment_requests,day_before_reminders_enabled,due_date_reminders_enabled,missed_payment_reminders_enabled,arrears_daily_reminders_enabled,arrears_reminder_limit,collections_retry_limit',id:'eq.true',limit:1});return rows?.[0]||{};}

export async function syncCollectionCases(today=todayZA()){
  const[loans,schedules]=await Promise.all([
    dbSelect('loans',{select:'id,user_id,status,outstanding_balance',status:'in.(active,overdue)',order:'created_at.asc',limit:1000}),
    dbSelect('repayment_schedule',{select:'id,loan_id,user_id,due_date,amount_due,amount_paid,status',due_date:`lte.${today}`,status:'not.in.(paid,waived)',order:'due_date.asc',limit:3000})
  ]);
  const byLoan=new Map();for(const s of schedules||[]){if(openAmount(s)<=0)continue;if(!byLoan.has(s.loan_id))byLoan.set(s.loan_id,[]);byLoan.get(s.loan_id).push(s);if(s.due_date<today&&s.status!=='overdue')await dbUpdate('repayment_schedule',{id:`eq.${s.id}`},{status:'overdue',updated_at:new Date().toISOString()}).catch(()=>{});}
  let overdue=0,resolved=0;
  for(const loan of loans||[]){
    const rows=(byLoan.get(loan.id)||[]).filter(s=>s.due_date<today);const amount=rows.reduce((sum,s)=>sum+openAmount(s),0);
    if(amount>0&&Number(loan.outstanding_balance)>0){
      overdue+=1;const oldest=rows[0],days=daysBetween(oldest.due_date,today);
      if(loan.status==='active')await dbUpdate('loans',{id:`eq.${loan.id}`},{status:'overdue',updated_at:new Date().toISOString()}).catch(()=>{});
      await supabaseRequest('/rest/v1/collection_cases?on_conflict=loan_id',{method:'POST',body:{loan_id:loan.id,user_id:loan.user_id,status:'overdue',days_past_due:days,overdue_amount:Math.round(amount*100)/100,resolved_at:null,updated_at:new Date().toISOString()},prefer:'resolution=merge-duplicates,return=minimal'});
    }else{
      const changed=await dbUpdate('collection_cases',{loan_id:`eq.${loan.id}`,status:'not.eq.resolved'},{status:'resolved',days_past_due:0,overdue_amount:0,next_action_at:null,resolved_at:new Date().toISOString(),updated_at:new Date().toISOString()}).catch(()=>[]);if(changed?.length)resolved+=1;
      if(loan.status==='overdue'&&Number(loan.outstanding_balance)>0)await dbUpdate('loans',{id:`eq.${loan.id}`},{status:'active',updated_at:new Date().toISOString()}).catch(()=>{});
    }
  }
  return{overdue,resolved};
}

export async function refreshPromiseStatuses(today=todayZA()){
  const promises=await dbSelect('collection_promises',{select:'*',status:'eq.active',order:'created_at.asc',limit:500});if(!promises?.length)return{kept:0,broken:0};
  const loanIds=[...new Set(promises.map(p=>p.loan_id))];
  const transactions=await dbSelect('loan_transactions',{select:'loan_id,transaction_date,amount,transaction_type',loan_id:`in.(${loanIds.join(',')})`,order:'transaction_date.asc',limit:5000});
  let kept=0,broken=0;
  for(const promise of promises){
    const paid=(transactions||[]).filter(t=>t.loan_id===promise.loan_id&&new Date(t.transaction_date)>=new Date(promise.created_at)).reduce((sum,t)=>t.transaction_type==='payment'?sum+Number(t.amount||0):t.transaction_type==='refund'?sum-Number(t.amount||0):sum,0);
    if(paid+0.005>=Number(promise.promised_amount)){
      kept+=1;await dbUpdate('collection_promises',{id:`eq.${promise.id}`},{status:'kept',resolved_at:new Date().toISOString(),updated_at:new Date().toISOString()});await insertEvent({event_key:`promise-kept:${promise.id}`,loan_id:promise.loan_id,schedule_id:promise.schedule_id,user_id:promise.user_id,event_type:'promise_kept',status:'completed',message:`Promise to pay kept. Received R${paid.toFixed(2)} after arrangement.`});continue;
    }
    if(String(promise.promised_date)<today){
      broken+=1;await dbUpdate('collection_promises',{id:`eq.${promise.id}`},{status:'broken',resolved_at:new Date().toISOString(),updated_at:new Date().toISOString()});await dbUpdate('collection_cases',{loan_id:`eq.${promise.loan_id}`},{status:'overdue',next_action_at:new Date().toISOString(),updated_at:new Date().toISOString()}).catch(()=>{});await insertEvent({event_key:`promise-broken:${promise.id}`,loan_id:promise.loan_id,schedule_id:promise.schedule_id,user_id:promise.user_id,event_type:'promise_broken',status:'completed',message:'Promise-to-pay date passed without the promised amount being received.'});
    }
  }
  return{kept,broken};
}

export async function runCollectionReminders(today=todayZA()){
  const settings=await collectionSettings(),tomorrow=addDays(today,1);
  const schedules=await dbSelect('repayment_schedule',{select:'id,loan_id,user_id,instalment_number,due_date,amount_due,amount_paid,status',due_date:`lte.${tomorrow}`,status:'not.in.(paid,waived)',order:'due_date.asc',limit:2000});
  if(!schedules?.length)return{sent:0,skipped:0,failed:0};
  const loanIds=[...new Set(schedules.map(s=>s.loan_id))],userIds=[...new Set(schedules.map(s=>s.user_id))];
  const[loans,profiles,cases,promises]=await Promise.all([
    dbSelect('loans',{select:'id,user_id,account_number,status,outstanding_balance,payout_status,collection_method',id:`in.(${loanIds.join(',')})`),
    dbSelect('customer_profiles',{select:'id,first_name,last_name,email,mobile',id:`in.(${userIds.join(',')})`),
    dbSelect('collection_cases',{select:'*',loan_id:`in.(${loanIds.join(',')})`}).catch(()=>[]),
    dbSelect('collection_promises',{select:'*',loan_id:`in.(${loanIds.join(',')})`,status:'eq.active'}).catch(()=>[])
  ]);
  const loanMap=new Map((loans||[]).map(r=>[r.id,r])),profileMap=new Map((profiles||[]).map(r=>[r.id,r])),caseMap=new Map((cases||[]).map(r=>[r.loan_id,r])),promiseMap=new Map((promises||[]).map(r=>[r.loan_id,r]));
  let sent=0,skipped=0,failed=0;
  for(const schedule of schedules){
    const loan=loanMap.get(schedule.loan_id);if(!loan||!['active','overdue'].includes(loan.status)||loan.payout_status!=='paid'||Number(loan.outstanding_balance)<=0||openAmount(schedule)<=0)continue;
    const promise=promiseMap.get(loan.id);if(promise&&String(promise.promised_date)>=today){skipped+=1;continue;}
    let kind=null,days=0;
    if(schedule.due_date===tomorrow&&settings.day_before_reminders_enabled&&loan.collection_method!=='debit_order')kind='due_tomorrow';
    else if(schedule.due_date===today&&settings.due_date_reminders_enabled)kind='due_today';
    else if(schedule.due_date<today){
      days=daysBetween(schedule.due_date,today);const cc=caseMap.get(loan.id),limit=Math.max(0,Number(settings.arrears_reminder_limit??7));if(Number(cc?.reminder_count||0)>=limit){skipped+=1;continue;}
      if(days===1&&settings.missed_payment_reminders_enabled)kind='missed_payment';else if(days>=2&&settings.arrears_daily_reminders_enabled)kind='arrears_daily';
    }
    if(!kind)continue;
    const event=await insertEvent({event_key:`reminder:${kind}:${schedule.id}:${today}`,loan_id:loan.id,schedule_id:schedule.id,user_id:loan.user_id,event_type:kind,status:'processing',message:`${kind} reminder scheduled for ${today}.`});if(!event)continue;
    try{
      const results=await sendCollectionReminder({profile:profileMap.get(loan.user_id),loan,schedule,kind,daysPastDue:days});const any=results.some(r=>r.sent);
      if(any){sent+=1;await dbUpdate('collection_events',{id:`eq.${event.id}`},{status:'completed',message:'Collection reminder sent.',metadata:{results},updated_at:new Date().toISOString()}).catch(()=>{});if(kind==='missed_payment'||kind==='arrears_daily')await dbUpdate('collection_cases',{loan_id:`eq.${loan.id}`},{reminder_count:Number(caseMap.get(loan.id)?.reminder_count||0)+1,last_reminder_at:new Date().toISOString(),next_action_at:new Date(Date.now()+86400000).toISOString(),updated_at:new Date().toISOString()}).catch(()=>{});}
      else{skipped+=1;await dbUpdate('collection_events',{id:`eq.${event.id}`},{status:'skipped',message:'No configured reminder channel was available.',metadata:{results}}).catch(()=>{});}
    }catch(error){failed+=1;await dbUpdate('collection_events',{id:`eq.${event.id}`},{status:'failed',message:String(error.message||error).slice(0,500)}).catch(()=>{});}
  }
  return{sent,skipped,failed};
}

export async function runCollectionsCycle(){const today=todayZA(),syncBefore=await syncCollectionCases(today),promises=await refreshPromiseStatuses(today),reminders=await runCollectionReminders(today),syncAfter=await syncCollectionCases(today);return{today,syncBefore,promises,reminders,syncAfter};}

export async function createPromiseToPay({loanId,amount,date,note,createdBy}){
  const loans=await dbSelect('loans',{select:'*',id:`eq.${loanId}`,limit:1});const loan=loans?.[0];if(!loan||!['active','overdue'].includes(loan.status)||Number(loan.outstanding_balance)<=0)throw new HttpError(409,'This loan cannot accept a promise to pay.','loan_not_collectible');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date))||String(date)<todayZA())throw new HttpError(400,'Promise date must be today or later.','invalid_promise_date');
  const promised=Math.round(Number(amount)*100)/100;if(!Number.isFinite(promised)||promised<=0||promised>Number(loan.outstanding_balance))throw new HttpError(400,'Promise amount must be within the outstanding balance.','invalid_promise_amount');
  const schedules=await dbSelect('repayment_schedule',{select:'*',loan_id:`eq.${loan.id}`,status:'not.in.(paid,waived)',order:'due_date.asc',limit:1});
  const created=await dbInsert('collection_promises',{loan_id:loan.id,schedule_id:schedules?.[0]?.id||null,user_id:loan.user_id,promised_amount:promised,promised_date:date,balance_at_promise:loan.outstanding_balance,note:String(note||'').trim()||null,created_by:createdBy});
  const promise=created?.[0];await supabaseRequest('/rest/v1/collection_cases?on_conflict=loan_id',{method:'POST',body:{loan_id:loan.id,user_id:loan.user_id,status:'promise_to_pay',overdue_amount:Number(loan.outstanding_balance),next_action_at:`${date}T08:00:00+02:00`,updated_at:new Date().toISOString()},prefer:'resolution=merge-duplicates,return=minimal'});
  if(promise)await insertEvent({event_key:`promise-created:${promise.id}`,loan_id:loan.id,schedule_id:promise.schedule_id,user_id:loan.user_id,event_type:'promise_created',status:'completed',message:`Promise to pay R${promised.toFixed(2)} by ${date}.`,created_by:createdBy});
  return promise;
}

export async function retryNetcashCollection({loanId,createdBy}){
  const settings=await collectionSettings();const cases=await dbSelect('collection_cases',{select:'*',loan_id:`eq.${loanId}`,limit:1});const cc=cases?.[0];
  if(Number(cc?.retry_count||0)>=Number(settings.collections_retry_limit??2))throw new HttpError(409,'The configured collection retry limit has been reached. Use a manual payment request or payment arrangement.','collection_retry_limit_reached');
  const instructions=await dbSelect('netcash_collection_instructions',{select:'*',loan_id:`eq.${loanId}`,status:'eq.unpaid',order:'processed_at.desc',limit:1});const instruction=instructions?.[0];if(!instruction)throw new HttpError(409,'No unpaid Netcash collection is available to retry.','collection_retry_not_available');
  if(instruction.resubmission_blocked)throw new HttpError(409,'Netcash has blocked resubmission for this collection. Use a manual payment request or review the return reason.','collection_resubmission_blocked');
  if(!instruction.debit_order_flow_id)throw new HttpError(409,'This collection does not have a recovery flow configured.','collection_flow_required');
  const result=await dbRpc('create_debit_order_recovery_instalment',{p_instruction_id:instruction.id,p_flow_id:instruction.debit_order_flow_id,p_due_date:addDays(todayZA(),1)});
  if(!['created','exists'].includes(result?.status))throw new HttpError(409,`Collection retry could not be created: ${result?.reason||result?.status||'not available'}.`,'collection_retry_failed');
  await supabaseRequest('/rest/v1/collection_cases?on_conflict=loan_id',{method:'POST',body:{loan_id:loanId,user_id:instruction.user_id,status:'retry_pending',retry_count:Number(cc?.retry_count||0)+1,next_action_at:`${addDays(todayZA(),1)}T08:00:00+02:00`,updated_at:new Date().toISOString()},prefer:'resolution=merge-duplicates,return=minimal'});
  await insertEvent({event_key:`retry:${instruction.id}:${Number(cc?.retry_count||0)+1}`,loan_id:loanId,schedule_id:instruction.schedule_id,user_id:instruction.user_id,event_type:'retry_collection',status:'completed',attempt:Number(cc?.retry_count||0)+1,message:'Netcash recovery collection scheduled.',metadata:result||{},created_by:createdBy});
  return result;
}
