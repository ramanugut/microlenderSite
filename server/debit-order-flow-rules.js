export const DEBIT_FLOW_APPLIES_TO=Object.freeze(['all','debicheck','standard_debit','card_debit']);
export const RECOVERY_DEBIT_POLICIES=Object.freeze(['same_instalment','up_to_mandate_max']);
export const DEBIT_FLOW_NODE_TYPES=Object.freeze(['start','reminder','presentment','tracking','result','paynow','late_fee','replacement','manual_review','end']);

const NODE_ID=/^[A-Za-z0-9_-]{1,64}$/;
const clamp=(value,min,max,fallback=min)=>{const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;};
const bool=(value,fallback=false)=>value===undefined?fallback:Boolean(value);

export function normaliseReturnCodes(value){
  const source=Array.isArray(value)?value:String(value||'02').split(/[\s,;]+/);
  return [...new Set(source.map(item=>String(item||'').trim()).filter(item=>/^\d{2}$/.test(item)))].slice(0,30);
}

function cleanNodeConfig(type,input={}){
  if(type==='reminder')return{days:clamp(input.days,1,7,1),email:bool(input.email,true),sms:bool(input.sms,false)};
  if(type==='tracking')return{days:clamp(input.days,1,10,5)};
  if(type==='result')return{recoverableReturnCodes:normaliseReturnCodes(input.recoverableReturnCodes),stopOnDispute:bool(input.stopOnDispute,true),stopOnNonRecoverable:bool(input.stopOnNonRecoverable,true)};
  if(type==='paynow')return{startAfterDays:clamp(input.startAfterDays,0,30,1),repeatEveryDays:clamp(input.repeatEveryDays,1,30,1),maxAttempts:clamp(input.maxAttempts,0,30,5)};
  if(type==='late_fee')return{amount:Math.max(0,Number(input.amount||0)),contractAuthorised:bool(input.contractAuthorised,false)};
  if(type==='replacement')return{afterDays:clamp(input.afterDays,1,60,6),policy:RECOVERY_DEBIT_POLICIES.includes(input.policy)?input.policy:'same_instalment',maximumMultiplier:clamp(input.maximumMultiplier,1,1.5,1.5),disputeRiskAck:bool(input.disputeRiskAck,false)};
  return{};
}

function assertAcyclic(nodes,edges){
  const indegree=new Map(nodes.map(node=>[node.id,0]));
  const outgoing=new Map(nodes.map(node=>[node.id,[]]));
  for(const edge of edges){indegree.set(edge.target,(indegree.get(edge.target)||0)+1);outgoing.get(edge.source)?.push(edge.target);}
  const queue=[...indegree.entries()].filter(([,degree])=>degree===0).map(([id])=>id);
  let visited=0;
  while(queue.length){const id=queue.shift();visited+=1;for(const target of outgoing.get(id)||[]){const next=(indegree.get(target)||0)-1;indegree.set(target,next);if(next===0)queue.push(target);}}
  if(visited!==nodes.length)throw new Error('Debit-order flows cannot contain loops.');
}

export function normaliseFlowGraph(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Flow graph is invalid.');
  const rawNodes=Array.isArray(input.nodes)?input.nodes:[];
  const rawEdges=Array.isArray(input.edges)?input.edges:[];
  if(rawNodes.length<3||rawNodes.length>40)throw new Error('A flow must contain between 3 and 40 nodes.');
  if(rawEdges.length>80)throw new Error('A flow cannot contain more than 80 connections.');
  const ids=new Set(),typeCounts=new Map();
  const nodes=rawNodes.map(raw=>{
    const id=String(raw?.id||'').trim(),type=String(raw?.type||'').trim();
    if(!NODE_ID.test(id)||ids.has(id))throw new Error('Every flow node needs a unique valid id.');
    if(!DEBIT_FLOW_NODE_TYPES.includes(type))throw new Error(`Unsupported flow node type: ${type||'unknown'}.`);
    ids.add(id);typeCounts.set(type,(typeCounts.get(type)||0)+1);
    return{id,type,x:clamp(raw.x,0,4000,80),y:clamp(raw.y,0,2400,80),config:cleanNodeConfig(type,raw.config||{})};
  });
  for(const [type,count] of typeCounts){if(count>1)throw new Error(`Only one ${type.replaceAll('_',' ')} node is allowed in a debit-order flow.`);}
  if((typeCounts.get('start')||0)!==1)throw new Error('A flow must have exactly one Start node.');
  if((typeCounts.get('presentment')||0)!==1)throw new Error('A flow must have exactly one Present debit node.');
  if((typeCounts.get('result')||0)!==1)throw new Error('A flow must have exactly one Provider result node.');

  const edgeKeys=new Set(),sourcePorts=new Set(),incoming=new Map(),nodeById=new Map(nodes.map(node=>[node.id,node]));
  const edges=rawEdges.map((raw,index)=>{
    const source=String(raw?.source||'').trim(),target=String(raw?.target||'').trim();
    if(!ids.has(source)||!ids.has(target)||source===target)throw new Error('A flow connection references an invalid node.');
    const sourceNode=nodeById.get(source),targetNode=nodeById.get(target);
    if(sourceNode.type==='end')throw new Error('The Complete node cannot have outgoing connections.');
    if(targetNode.type==='start')throw new Error('The Start node cannot have incoming connections.');
    const allowedPorts=sourceNode.type==='result'?['paid','unpaid','blocked']:['out'];
    const sourcePort=allowedPorts.includes(raw?.sourcePort)?raw.sourcePort:allowedPorts[0];
    const sourceKey=`${source}:${sourcePort}`;
    if(sourcePorts.has(sourceKey))throw new Error('Each node output may connect to only one next step.');
    sourcePorts.add(sourceKey);
    const incomingCount=(incoming.get(target)||0)+1;incoming.set(target,incomingCount);
    if(incomingCount>1&&!['end','manual_review'].includes(targetNode.type))throw new Error(`${targetNode.type.replaceAll('_',' ')} may have only one incoming connection.`);
    const key=`${sourceKey}:${target}`;
    if(edgeKeys.has(key))throw new Error('Duplicate flow connections are not allowed.');
    edgeKeys.add(key);
    const id=NODE_ID.test(String(raw?.id||''))?String(raw.id):`edge_${index}_${source}_${target}`.slice(0,64);
    return{id,source,target,sourcePort};
  });
  assertAcyclic(nodes,edges);
  return{version:1,nodes,edges};
}

function reachable(graph,startIds){
  const seen=new Set(startIds),queue=[...startIds];
  while(queue.length){const current=queue.shift();for(const edge of graph.edges){if(edge.source===current&&!seen.has(edge.target)){seen.add(edge.target);queue.push(edge.target);}}}
  return seen;
}
function branchReachable(graph,resultId,port){const first=graph.edges.filter(edge=>edge.source===resultId&&edge.sourcePort===port).map(edge=>edge.target);return reachable(graph,first);}

function compileGraph(graph,seed){
  const start=graph.nodes.find(node=>node.type==='start'),present=graph.nodes.find(node=>node.type==='presentment'),result=graph.nodes.find(node=>node.type==='result'),end=graph.nodes.find(node=>node.type==='end');
  const fromStart=reachable(graph,[start.id]);
  if(!fromStart.has(present.id))throw new Error('Connect Start to Present debit before saving.');
  const fromPresent=reachable(graph,[present.id]);
  if(!fromPresent.has(result.id))throw new Error('Connect Present debit to Provider result before saving.');
  const paid=branchReachable(graph,result.id,'paid'),unpaid=branchReachable(graph,result.id,'unpaid'),blocked=branchReachable(graph,result.id,'blocked');
  if(!paid.size)throw new Error('Connect the Paid output from Provider result.');
  if(!unpaid.size)throw new Error('Connect the Unpaid output from Provider result.');
  if(!blocked.size)throw new Error('Connect the Blocked output from Provider result.');
  if(end&&!paid.has(end.id))throw new Error('The Paid branch must reach Complete.');

  const node=type=>graph.nodes.find(item=>item.type===type);
  const reminder=node('reminder'),tracking=node('tracking'),paynow=node('paynow'),lateFee=node('late_fee'),replacement=node('replacement'),manualReview=node('manual_review');
  const resultConfig=result.config||{};
  const preReminderEnabled=Boolean(reminder&&fromStart.has(reminder.id));
  const trackingEnabled=Boolean(tracking&&fromPresent.has(tracking.id));
  const paynowAfterFailure=Boolean(paynow&&unpaid.has(paynow.id));
  const lateFeeEnabled=Boolean(lateFee&&unpaid.has(lateFee.id)&&Number(lateFee.config?.amount||0)>0);
  const replacementInstalmentEnabled=Boolean(replacement&&unpaid.has(replacement.id));

  if(preReminderEnabled&&!reachable(graph,[reminder.id]).has(present.id))throw new Error('The Reminder node must lead to Present debit.');
  if(trackingEnabled&&!reachable(graph,[tracking.id]).has(result.id))throw new Error('The Tracking node must lead to Provider result.');
  if(paynowAfterFailure&&replacementInstalmentEnabled&&!reachable(graph,[paynow.id]).has(replacement.id))throw new Error('When both are used, Pay Now must lead to Recovery instalment.');
  if(lateFeeEnabled&&replacementInstalmentEnabled&&!reachable(graph,[lateFee.id]).has(replacement.id))throw new Error('The Late fee node must lead to Recovery instalment.');
  if(lateFeeEnabled&&paynowAfterFailure&&!reachable(graph,[paynow.id]).has(lateFee.id))throw new Error('When both are used, Pay Now must lead to Late fee.');
  if((resultConfig.stopOnDispute!==false||resultConfig.stopOnNonRecoverable!==false)&&manualReview&&!blocked.has(manualReview.id))throw new Error('Connect the Blocked output to Manual review.');

  const recoveryDebitPolicy=replacement?.config?.policy||'same_instalment';
  const aboveInstalmentDisputeRiskAck=Boolean(replacement?.config?.disputeRiskAck);
  const lateFeeContractAuthorised=Boolean(lateFee?.config?.contractAuthorised);
  if(recoveryDebitPolicy==='up_to_mandate_max'&&replacementInstalmentEnabled&&!aboveInstalmentDisputeRiskAck)throw new Error('The recovery-instalment node requires acknowledgement before it may collect above the regular instalment.');
  if(lateFeeEnabled&&!lateFeeContractAuthorised)throw new Error('The late-fee node requires confirmation that the credit agreement authorises the fee.');
  return{
    ...seed,graph,
    preReminderEnabled,preReminderDays:reminder?.config?.days||1,preReminderEmail:Boolean(reminder?.config?.email),preReminderSms:Boolean(reminder?.config?.sms),
    trackingEnabled,trackingDays:tracking?.config?.days||1,
    recoverableReturnCodes:normaliseReturnCodes(resultConfig.recoverableReturnCodes),stopOnDispute:resultConfig.stopOnDispute!==false,stopOnNonInsufficientFunds:resultConfig.stopOnNonRecoverable!==false,
    paynowAfterFailure,paynowStartAfterDays:paynow?.config?.startAfterDays??1,paynowRepeatEveryDays:paynow?.config?.repeatEveryDays??1,paynowMaxAttempts:paynow?.config?.maxAttempts??5,
    replacementInstalmentEnabled,replacementAfterDays:replacement?.config?.afterDays??6,recoveryDebitPolicy,maximumMultiplier:replacement?.config?.maximumMultiplier??1.5,aboveInstalmentDisputeRiskAck,
    lateFeeEnabled,lateFeeAmount:lateFee?.config?.amount??0,lateFeeContractAuthorised
  };
}

export function validateDebitOrderFlow(input={}){
  const name=String(input.name||'').trim();
  if(name.length<2||name.length>80)throw new Error('Flow name must be between 2 and 80 characters.');
  const appliesTo=DEBIT_FLOW_APPLIES_TO.includes(input.appliesTo)?input.appliesTo:'debicheck';
  const seed={name,description:String(input.description||'').trim().slice(0,500),enabled:input.enabled!==false,isDefault:Boolean(input.isDefault),appliesTo};
  if(input.graph){
    const graph=normaliseFlowGraph(input.graph);
    const compiled=compileGraph(graph,seed);
    if(!compiled.recoverableReturnCodes.length)throw new Error('The Provider result node needs at least one valid two-digit recoverable return code.');
    return compiled;
  }

  const preReminderDays=clamp(input.preReminderDays,1,7,1),trackingDays=clamp(input.trackingDays,1,10,1),paynowStartAfterDays=clamp(input.paynowStartAfterDays,0,30,1),paynowRepeatEveryDays=clamp(input.paynowRepeatEveryDays,1,30,1),paynowMaxAttempts=clamp(input.paynowMaxAttempts,0,30,5),replacementAfterDays=clamp(input.replacementAfterDays,1,60,6);
  const recoveryDebitPolicy=RECOVERY_DEBIT_POLICIES.includes(input.recoveryDebitPolicy)?input.recoveryDebitPolicy:'same_instalment';
  const maximumMultiplier=clamp(input.maximumMultiplier,1,1.5,1.5),aboveInstalmentDisputeRiskAck=Boolean(input.aboveInstalmentDisputeRiskAck),lateFeeEnabled=Boolean(input.lateFeeEnabled),lateFeeAmount=Math.max(0,Number(input.lateFeeAmount||0)),lateFeeContractAuthorised=Boolean(input.lateFeeContractAuthorised),recoverableReturnCodes=normaliseReturnCodes(input.recoverableReturnCodes);
  if(!recoverableReturnCodes.length)throw new Error('Add at least one valid two-digit recoverable return code.');
  if(recoveryDebitPolicy==='up_to_mandate_max'&&!aboveInstalmentDisputeRiskAck)throw new Error('Above-instalment recovery requires acknowledgement that the debit can still be disputable.');
  if(lateFeeEnabled&&lateFeeAmount>0&&!lateFeeContractAuthorised)throw new Error('Late fees can only be enabled after confirming the credit agreement authorises the fee.');
  return{...seed,preReminderEnabled:input.preReminderEnabled!==false,preReminderDays,preReminderEmail:input.preReminderEmail!==false,preReminderSms:Boolean(input.preReminderSms),trackingEnabled:input.trackingEnabled!==false,trackingDays,paynowAfterFailure:input.paynowAfterFailure!==false,paynowStartAfterDays,paynowRepeatEveryDays,paynowMaxAttempts,replacementInstalmentEnabled:input.replacementInstalmentEnabled!==false,replacementAfterDays,recoveryDebitPolicy,maximumMultiplier,aboveInstalmentDisputeRiskAck,lateFeeEnabled,lateFeeAmount,lateFeeContractAuthorised,stopOnDispute:input.stopOnDispute!==false,stopOnNonInsufficientFunds:input.stopOnNonInsufficientFunds!==false,recoverableReturnCodes,graph:null};
}

export function flowToDatabase(flow){return{
  name:flow.name,description:flow.description||null,enabled:flow.enabled,is_default:flow.isDefault,applies_to:flow.appliesTo,
  pre_reminder_enabled:flow.preReminderEnabled,pre_reminder_days:flow.preReminderDays,pre_reminder_email:flow.preReminderEmail,pre_reminder_sms:flow.preReminderSms,
  tracking_enabled:flow.trackingEnabled,tracking_days:flow.trackingDays,paynow_after_failure:flow.paynowAfterFailure,paynow_start_after_days:flow.paynowStartAfterDays,paynow_repeat_every_days:flow.paynowRepeatEveryDays,paynow_max_attempts:flow.paynowMaxAttempts,
  replacement_instalment_enabled:flow.replacementInstalmentEnabled,replacement_after_days:flow.replacementAfterDays,recovery_debit_policy:flow.recoveryDebitPolicy,maximum_multiplier:flow.maximumMultiplier,above_instalment_dispute_risk_ack:flow.aboveInstalmentDisputeRiskAck,
  late_fee_enabled:flow.lateFeeEnabled,late_fee_amount:flow.lateFeeAmount,late_fee_contract_authorised:flow.lateFeeContractAuthorised,stop_on_dispute:flow.stopOnDispute,stop_on_non_insufficient_funds:flow.stopOnNonInsufficientFunds,recoverable_return_codes:flow.recoverableReturnCodes,
  flow_definition:flow.graph||null,graph_version:1,updated_at:new Date().toISOString()
};}
