import { dbInsert, dbSelect, dbUpdate } from './supabase-rest.js';

function taskMarker(batchName){return `[NETCASH-BATCH:${batchName}]`;}
function dueAt(row){
  const date=String(row.presentation_date||row.action_date||row.due_date||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return new Date().toISOString();
  return `${date}T08:00:00+02:00`;
}
function streamLabel(value){return value==='efts'?'Same-Day EFT':value==='eft_2day'?'2-Day EFT':'DebiCheck';}

async function taskOwner(){
  const rows=await dbSelect('staff_members',{select:'user_id,role,status',status:'eq.active',role:'in.(owner,manager,collections)',limit:20}).catch(()=>[]);
  return (rows||[]).sort((a,b)=>({owner:0,manager:1,collections:2}[a.role]??9)-({owner:0,manager:1,collections:2}[b.role]??9))[0]?.user_id||null;
}

export async function syncNetcashAuthorisationTasks(){
  const owner=await taskOwner();
  if(!owner)return{created:0,closed:0,skipped:true,reason:'no_active_staff'};
  const instructions=await dbSelect('netcash_collection_instructions',{
    select:'id,batch_name,loan_id,user_id,collection_stream,action_date,presentation_date,due_date,status,authorisation_status',
    authorisation_status:'eq.manual_required',status:'in.(submitted,accepted)',batch_name:'not.is.null',limit:500
  }).catch(()=>[]);
  const groups=new Map();
  for(const row of instructions||[]){if(!groups.has(row.batch_name))groups.set(row.batch_name,[]);groups.get(row.batch_name).push(row);}
  const openTasks=await dbSelect('business_tasks',{select:'id,title,description,status,loan_id',status:'in.(open,in_progress)',task_type:'eq.collection',limit:1000}).catch(()=>[]);
  let created=0;
  for(const [batchName,rows] of groups){
    const marker=taskMarker(batchName);
    if((openTasks||[]).some(task=>String(task.description||'').includes(marker)))continue;
    const first=rows[0];
    const actionDate=first.action_date||first.due_date;
    const cutoffNote=first.presentation_date?`Presentation/authorisation date: ${first.presentation_date}.`:`Action date: ${actionDate}.`;
    await dbInsert('business_tasks',{
      title:'Authorise Netcash debit batch',
      description:`${marker} ${streamLabel(first.collection_stream)} batch ${batchName} is loaded and requires authorisation in Netcash. ${cutoffNote} ${rows.length} collection instruction(s). Do not assume Auto Batch Authorization unless Netcash has approved and enabled it for this merchant account.`.slice(0,1000),
      task_type:'collection',priority:'urgent',status:'open',user_id:first.user_id,loan_id:first.loan_id,assigned_to:owner,due_at:dueAt(first),created_by:owner
    });
    created+=1;
  }

  let closed=0;
  for(const task of openTasks||[]){
    const marker=String(task.description||'').match(/\[NETCASH-BATCH:([^\]]+)\]/)?.[1];
    if(!marker||groups.has(marker))continue;
    const rows=await dbSelect('netcash_collection_instructions',{select:'id,authorisation_status,status',batch_name:`eq.${marker}`,limit:50}).catch(()=>[]);
    if(!rows?.length)continue;
    const stillNeeds=(rows||[]).some(row=>row.authorisation_status==='manual_required'&&['submitted','accepted'].includes(row.status));
    if(!stillNeeds){await dbUpdate('business_tasks',{id:`eq.${task.id}`},{status:'done',updated_at:new Date().toISOString()}).catch(()=>{});closed+=1;}
  }
  return{created,closed,pendingBatches:groups.size};
}
