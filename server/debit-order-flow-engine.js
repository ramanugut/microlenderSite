import { sendPreCollectionReminder, notificationCapabilities } from './customer-notifications.js';
import { sendNetcashPaymentRequest } from './netcash-payment-service.js';
import { dbInsert, dbRpc, dbSelect, dbUpdate } from './supabase-rest.js';

function todayZA(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Johannesburg',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function addDays(value,days){const d=new Date(`${value}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function daysBetween(a,b){return Math.floor((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000);}
function streamKind(stream){if(stream==='debicheck')return'debicheck';if(stream==='efts'||stream==='eft_2day')return'standard_debit';return'all';}
function recoverable(flow,code){const list=Array.isArray(flow?.recoverable_return_codes)?flow.recoverable_return_codes:[];return list.map(String).includes(String(code||''));}

async function flows(){return dbSelect('debit_order_flows',{select:'*',enabled:'eq.true',archived_at:'is.null',order:'is_default.desc,created_at.asc',limit:100}).catch(()=>[]);}
function selectFlow(loan,all,stream){if(loan?.debit_order_flow_id){const direct=all.find(f=>f.id===loan.debit_order_flow_id);if(direct)return direct;}const kind=streamKind(stream||loan?.netcash_collection_stream);return all.find(f=>f.is_default&&(f.applies_to===kind||f.applies_to==='all'))||all.find(f=>f.is_default)||all.find(f=>f.applies_to===kind)||all.find(f=>f.applies_to==='all')||null;}
async function createEvent(body){try{return(await dbInsert('debit_order_flow_events',body))?.[0]||null;}catch(error){if(error.databaseCode==='23505'||error.code==='23505')return null;throw error;}}
async function completeEvent(id,status,message,metadata={}){if(!id)return;await dbUpdate('debit_order_flow_events',{id:`eq.${id}`},{status,message:String(message||'').slice(0,500)||null,metadata,completed_at:new Date().toISOString(),updated_at:new Date().toISOString()});}

async function preCollectionReminders(allFlows,today){
  const maxDays=Math.max(1,...allFlows.filter(f=>f.pre_reminder_enabled).map(f=>Number(f.pre_reminder_days||1))),horizon=addDays(today,maxDays);
  let schedules=await dbSelect('repayment_schedule',{select:'id,loan_id,user_id,instalment_number,due_date,amount_due,amount_paid,status',due_date:`gte.${today}`,status:'not.in.(paid,waived)',order:'due_date.asc',limit:500}).catch(()=>[]);
  schedules=(schedules||[]).filter(row=>String(row.due_date)<=horizon);
  if(!schedules.length)return{examined:0,sent:0,skipped:0,failed:0};
  const loanIds=[...new Set(schedules.map(r=>r.loan_id))],userIds=[...new Set(schedules.map(r=>r.user_id))];
  const[loans,profiles]=await Promise.all([dbSelect('loans',{select:'id,user_id,account_number,status,outstanding_balance,payout_status,netcash_collection_stream,debit_order_flow_id',id:`in.(${loanIds.join(',')})`}),dbSelect('customer_profiles',{select:'id,first_name,last_name,email,mobile',id:`in.(${userIds.join(',')})`})]);
  const loanMap=new Map((loans||[]).map(r=>[r.id,r])),profileMap=new Map((profiles||[]).map(r=>[r.id,r]));let sent=0,skipped=0,failed=0;
  for(const schedule of schedules){
    const loan=loanMap.get(schedule.loan_id);if(!loan||!['active','overdue'].includes(loan.status)||loan.payout_status!=='paid'||Number(loan.outstanding_balance)<=0)continue;
    const flow=selectFlow(loan,allFlows,loan.netcash_collection_stream);if(!flow?.pre_reminder_enabled||schedule.due_date!==addDays(today,Number(flow.pre_reminder_days||1)))continue;
    const event=await createEvent({event_key:`pre:${schedule.id}:${schedule.due_date}`,flow_id:flow.id,loan_id:loan.id,schedule_id:schedule.id,event_type:'pre_reminder',scheduled_for:today,status:'processing',metadata:{channels:{email:flow.pre_reminder_email,sms:flow.pre_reminder_sms}}});if(!event)continue;
    try{const result=await sendPreCollectionReminder({profile:profileMap.get(schedule.user_id),loan,schedule,flow}),any=result.some(r=>r.sent),errors=result.filter(r=>r.error);if(any){sent+=1;await completeEvent(event.id,'completed','Pre-collection reminder sent.',{results:result});}else{skipped+=1;await completeEvent(event.id,errors.length?'failed':'skipped',errors.map(e=>e.error).join('; ')||'Selected reminder channels are not configured.',{results:result});if(errors.length)failed+=1;}}catch(error){failed+=1;await completeEvent(event.id,'failed',error.message,{error:error.message});}
  }
  return{examined:schedules.length,sent,skipped,failed};
}

async function recoveryForUnpaids(allFlows,today){
  await dbRpc('expire_netcash_payment_requests',{}).catch(()=>0);
  const instructions=await dbSelect('netcash_collection_instructions',{select:'*',status:'eq.unpaid',processed_at:'not.is.null',order:'processed_at.asc',limit:500}).catch(()=>[]);
  if(!instructions.length)return{examined:0,payNowSent:0,replacements:0,manualReview:0,failed:0};
  const loanIds=[...new Set(instructions.map(r=>r.loan_id))],scheduleIds=[...new Set(instructions.map(r=>r.schedule_id))];
  const[loans,schedules,events]=await Promise.all([dbSelect('loans',{select:'id,user_id,account_number,status,outstanding_balance,payout_status,instalment_amount,netcash_collection_stream,debit_order_flow_id',id:`in.(${loanIds.join(',')})`}),dbSelect('repayment_schedule',{select:'*',id:`in.(${scheduleIds.join(',')})`}),dbSelect('debit_order_flow_events',{select:'*',instruction_id:`in.(${instructions.map(r=>r.id).join(',')})`,order:'created_at.asc',limit:5000}).catch(()=>[])]);
  const loanMap=new Map((loans||[]).map(r=>[r.id,r])),scheduleMap=new Map((schedules||[]).map(r=>[r.id,r])),eventMap=new Map();for(const e of events||[]){if(!eventMap.has(e.instruction_id))eventMap.set(e.instruction_id,[]);eventMap.get(e.instruction_id).push(e);}let payNowSent=0,replacements=0,manualReview=0,failed=0;
  for(const instruction of instructions){
    const loan=loanMap.get(instruction.loan_id),schedule=scheduleMap.get(instruction.schedule_id);if(!loan||!schedule||!['active','overdue'].includes(loan.status)||Number(loan.outstanding_balance)<=0||['paid','waived'].includes(schedule.status))continue;
    const flow=selectFlow(loan,allFlows,instruction.collection_stream);if(!flow)continue;
    const history=eventMap.get(instruction.id)||[],code=String(instruction.last_return_code||instruction.provider_result||'').trim(),returnDate=String(instruction.processed_at).slice(0,10),elapsed=Math.max(0,daysBetween(returnDate,today));
    if(!history.some(e=>e.event_type==='failure_detected')){const event=await createEvent({event_key:`failure:${instruction.id}`,flow_id:flow.id,loan_id:loan.id,schedule_id:schedule.id,instruction_id:instruction.id,event_type:'failure_detected',scheduled_for:returnDate,status:'completed',message:`Debit order returned with ${code||'unknown'} result.`,completed_at:new Date().toISOString(),metadata:{returnCode:code,returnCount:instruction.return_count}});if(event)history.push(event);}
    const dispute=instruction.provider_result==='DCD'||code==='DCD';
    if(instruction.resubmission_blocked||(flow.stop_on_dispute&&dispute)||(flow.stop_on_non_insufficient_funds&&!recoverable(flow,code))){if(!history.some(e=>e.event_type==='manual_review')){const event=await createEvent({event_key:`review:${instruction.id}`,flow_id:flow.id,loan_id:loan.id,schedule_id:schedule.id,instruction_id:instruction.id,event_type:'manual_review',scheduled_for:today,status:'completed',message:instruction.resubmission_blocked?'Automatic recovery stopped because the provider blocked resubmission.':dispute?'Automatic recovery stopped because the DebiCheck was disputed.':`Return code ${code||'unknown'} is not configured for automatic recovery.`,completed_at:new Date().toISOString(),metadata:{returnCode:code,resubmissionBlocked:instruction.resubmission_blocked}});if(event)manualReview+=1;}continue;}
    const payEvents=history.filter(e=>e.event_type==='paynow_recovery'),attempts=payEvents.reduce((max,e)=>Math.max(max,Number(e.attempt||0)),0),maxAttempts=Number(flow.paynow_max_attempts||0);
    if(flow.paynow_after_failure&&attempts<maxAttempts){
      const nextDay=Number(flow.paynow_start_after_days||1)+(attempts*Number(flow.paynow_repeat_every_days||1));
      if(elapsed>=nextDay){const active=await dbSelect('netcash_payment_requests',{select:'id,status',schedule_id:`eq.${schedule.id}`,status:'in.(initializing,pending)',limit:1}).catch(()=>[]);if(!active?.length){const nextAttempt=attempts+1,event=await createEvent({event_key:`paynow:${instruction.id}:${nextAttempt}`,flow_id:flow.id,loan_id:loan.id,schedule_id:schedule.id,instruction_id:instruction.id,event_type:'paynow_recovery',attempt:nextAttempt,scheduled_for:today,status:'processing',metadata:{returnCode:code}});if(event){try{const result=await sendNetcashPaymentRequest({loanId:loan.id,scheduleId:schedule.id,paymentType:'instalment',source:'automatic',triggerKind:`debit_failure_${nextAttempt}`});if(result?.request?.id)await dbUpdate('netcash_payment_requests',{id:`eq.${result.request.id}`},{expires_at:`${today}T23:59:59+02:00`,provider_metadata:{...(result.request.provider_metadata||{}),debit_order_flow_id:flow.id,recovery_instruction_id:instruction.id,recovery_attempt:nextAttempt},updated_at:new Date().toISOString()});await completeEvent(event.id,'completed','Automatic Pay Now recovery request sent.',{requestId:result?.request?.id||null,attempt:nextAttempt});payNowSent+=1;}catch(error){failed+=1;await completeEvent(event.id,'failed',error.message,{error:error.message,attempt:nextAttempt});}}}continue;}
    }
    const payNowExhausted=!flow.paynow_after_failure||attempts>=maxAttempts;
    if(flow.replacement_instalment_enabled&&payNowExhausted&&elapsed>=Number(flow.replacement_after_days||6)&&!history.some(e=>e.event_type==='replacement_instalment'&&e.status==='completed')){const event=await createEvent({event_key:`replacement:${instruction.id}`,flow_id:flow.id,loan_id:loan.id,schedule_id:schedule.id,instruction_id:instruction.id,event_type:'replacement_instalment',scheduled_for:today,status:'processing',metadata:{policy:flow.recovery_debit_policy,maximumMultiplier:flow.maximum_multiplier}});if(event){try{const result=await dbRpc('create_debit_order_recovery_instalment',{p_instruction_id:instruction.id,p_flow_id:flow.id,p_due_date:addDays(today,1)}),status=result?.status==='created'||result?.status==='exists'?'completed':'skipped';await completeEvent(event.id,status,result?.status==='created'?'Replacement arrears instalment created.':`Replacement action: ${result?.reason||result?.status||'skipped'}`,result||{});if(result?.status==='created'||result?.status==='exists')replacements+=1;else if(result?.status==='manual_review')manualReview+=1;}catch(error){failed+=1;await completeEvent(event.id,'failed',error.message,{error:error.message});}}}
  }
  return{examined:instructions.length,payNowSent,replacements,manualReview,failed};
}

export async function runDebitOrderFlowMaintenance(){const allFlows=await flows();if(!allFlows.length)return{skipped:true,reason:'no_active_flows',capabilities:notificationCapabilities()};const today=todayZA(),reminders=await preCollectionReminders(allFlows,today),recovery=await recoveryForUnpaids(allFlows,today);return{today,capabilities:notificationCapabilities(),reminders,recovery};}
export async function debitOrderFlowSnapshot(){const[allFlows,recentEvents]=await Promise.all([dbSelect('debit_order_flows',{select:'*',archived_at:'is.null',order:'is_default.desc,created_at.asc',limit:100}),dbSelect('debit_order_flow_events',{select:'*',order:'created_at.desc',limit:100}).catch(()=>[])]);return{flows:allFlows||[],recentEvents:recentEvents||[],capabilities:notificationCapabilities()};}
