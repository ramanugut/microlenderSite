import { dbInsert, dbSelect, dbUpdate } from './supabase-rest.js';

const TYPES=new Set(['quotation','pre_agreement_statement','credit_agreement','debicheck_mandate','settlement_letter','paid_up_letter','statement','notice']);
const TITLE={quotation:'Quotation',pre_agreement_statement:'Pre-agreement statement',credit_agreement:'Credit agreement',debicheck_mandate:'DebiCheck mandate',settlement_letter:'Settlement letter',paid_up_letter:'Paid-up letter',statement:'Loan statement',notice:'Notice'};
const money=value=>`R${Number(value||0).toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const date=value=>value?new Intl.DateTimeFormat('en-ZA',{timeZone:'Africa/Johannesburg',day:'2-digit',month:'short',year:'numeric'}).format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value))?`${value}T00:00:00+02:00`:value)):'—';
const text=value=>String(value??'—').replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim();
const escapePdf=value=>text(value).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
const safePath=value=>String(value||'document').replace(/[^a-z0-9_-]+/gi,'-').replace(/^-+|-+$/g,'').toLowerCase()||'document';

function wrap(line,max=92){
  const words=text(line).split(' '),out=[];let current='';
  for(const word of words){if(!word)continue;const next=current?`${current} ${word}`:word;if(next.length>max&&current){out.push(current);current=word;}else current=next;}if(current)out.push(current);return out;
}
function pdfBuffer(title,lines){
  const rows=[];for(const line of lines){if(line===''){rows.push('');continue;}rows.push(...wrap(line));}
  const pages=[];for(let i=0;i<rows.length;i+=42)pages.push(rows.slice(i,i+42));if(!pages.length)pages.push([]);
  const objects=[];const add=value=>{objects.push(value);return objects.length;};
  const font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const bold=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds=[],contentIds=[];
  for(const pageRows of pages){
    const ops=['BT','/F2 16 Tf','50 790 Td',`(${escapePdf(title)}) Tj`,'/F1 9 Tf','0 -25 Td'];
    for(const row of pageRows){ops.push(`(${escapePdf(row)}) Tj`,'0 -16 Td');}
    ops.push('ET');const stream=ops.join('\n');const content=add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);contentIds.push(content);pageIds.push(add('PAGE_PLACEHOLDER'));
  }
  const pagesId=add('PAGES_PLACEHOLDER');
  pageIds.forEach((id,index)=>{objects[id-1]=`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`;});
  objects[pagesId-1]=`<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const catalog=add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let output='%PDF-1.4\n';const offsets=[0];objects.forEach((object,index)=>{offsets[index+1]=Buffer.byteLength(output);output+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(output);output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(let i=1;i<=objects.length;i++)output+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;output+=`trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output,'binary');
}
async function storageUpload(bucket,path,buffer,contentType='application/pdf'){
  const base=String(process.env.SUPABASE_URL||'').replace(/\/$/,'');const key=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'');if(!base||!key)throw new Error('Secure storage is not configured.');
  const response=await fetch(`${base}/storage/v1/object/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':contentType,'x-upsert':'true'},body:buffer,signal:AbortSignal.timeout(20000)});
  if(!response.ok){const payload=await response.text();throw new Error(`Document storage failed: ${payload.slice(0,180)}`);}return path;
}
async function source(job){
  const [settings,compliance,profiles,applications,loans,schedules,transactions,contracts,settlements]=await Promise.all([
    dbSelect('lender_settings',{select:'*',id:'eq.true',limit:1}),dbSelect('lender_compliance_profile',{select:'*',id:'eq.true',limit:1}),dbSelect('customer_profiles',{select:'*',id:`eq.${job.user_id}`,limit:1}),job.application_id?dbSelect('loan_applications',{select:'*',id:`eq.${job.application_id}`,limit:1}):Promise.resolve([]),job.loan_id?dbSelect('loans',{select:'*',id:`eq.${job.loan_id}`,limit:1}):Promise.resolve([]),job.loan_id?dbSelect('repayment_schedule',{select:'*',loan_id:`eq.${job.loan_id}`,order:'due_date.asc,instalment_number.asc'}):Promise.resolve([]),job.loan_id?dbSelect('loan_transactions',{select:'*',loan_id:`eq.${job.loan_id}`,order:'transaction_date.asc'}):Promise.resolve([]),job.loan_id?dbSelect('netcash_contracts',{select:'*',loan_id:`eq.${job.loan_id}`,order:'created_at.desc',limit:1}):Promise.resolve([]),job.loan_id?dbSelect('loan_settlement_letters',{select:'*',loan_id:`eq.${job.loan_id}`,order:'created_at.desc',limit:1}):Promise.resolve([])
  ]);
  return{settings:settings?.[0]||{},compliance:compliance?.[0]||{},profile:profiles?.[0]||{},application:applications?.[0]||{},loan:loans?.[0]||{},schedules:schedules||[],transactions:transactions||[],contract:contracts?.[0]||{},settlement:settlements?.[0]||{}};
}
function lenderLines(s){const lender=s.settings||{},c=s.compliance||{};return[`Credit provider: ${lender.legal_name||lender.business_name||'Lender'}`,`NCR registration: ${lender.ncr_registration_number||'Not configured'}`,`Registration number: ${lender.registration_number||'Not configured'}`,`Address: ${lender.physical_address||'Not configured'}`,`Support: ${lender.support_email||'—'} | ${lender.support_phone||'—'}`,`Complaints: ${c.complaints_email||lender.support_email||'—'} | ${c.complaints_phone||lender.support_phone||'—'}`];}
function loanFacts(s){const l=s.loan,a=s.application,p=s.profile;return[`Client: ${[p.first_name||a.first_name,p.last_name||a.last_name].filter(Boolean).join(' ')||'Client'}`,`Application reference: ${a.reference||'—'}`,`Loan account: ${l.account_number||'—'}`,`Principal amount: ${money(l.principal_amount)}`,`Interest: ${money(l.interest_amount)}`,`Initiation fee: ${money(l.initiation_fee)}`,`Service fee: ${money(l.service_fee)}`,`Total repayable: ${money(l.total_repayable)}`,`Term: ${l.term_months||a.loan_term_months||'—'} month(s)`,`Repayment frequency: ${text(l.repayment_frequency)}`,`Instalment: ${money(l.instalment_amount)}`,`Start date: ${date(l.start_date)}`,`Final due date: ${date(l.due_date)}`];}
function scheduleLines(s){return s.schedules.length?['Repayment schedule:',...s.schedules.map(r=>`Instalment ${r.instalment_number}: ${date(r.due_date)} | due ${money(r.amount_due)} | paid ${money(r.amount_paid)} | ${text(r.status)}`)]:['Repayment schedule: not available.'];}
function statementLines(s){const tx=s.transactions.length?s.transactions.map(r=>`${date(r.transaction_date)} | ${text(r.description)} | ${text(r.transaction_type)} | ${money(r.amount)}`):['No transactions recorded.'];return[...loanFacts(s),'',`Current outstanding balance: ${money(s.loan.outstanding_balance)}`,'','Transactions:',...tx,'',...scheduleLines(s)];}
function documentLines(type,s,payload){
  const base=[...lenderLines(s),'',...loanFacts(s),''];
  if(type==='quotation')return[...base,'This quotation summarises the proposed credit costs and repayment terms. It does not by itself confirm that funds have been disbursed.','',...scheduleLines(s)];
  if(type==='pre_agreement_statement')return[...base,'Pre-agreement disclosure','Review the principal debt, interest, fees, repayment dates, total repayable and credit-provider details before accepting the credit agreement.','',...scheduleLines(s),'','Client may contact the lender before acceptance if any term or cost is unclear.'];
  if(type==='credit_agreement')return[...base,'Credit agreement record','This document records the approved loan terms stored by KredRun. The agreement is subject to the lender’s configured terms, applicable South African credit law and the client consents captured with the application.','',...scheduleLines(s),'',`Collection method: ${text(s.loan.collection_method)}`];
  if(type==='debicheck_mandate')return[...base,'DebiCheck mandate record',`Mandate status: ${text(s.contract.mandate_status||payload.mandate_status)}`,`Provider contract reference: ${text(s.contract.provider_contract_reference||payload.provider_reference)}`,`Authorisation mode: ${text(s.contract.debicheck_auth_mode)}`,`Authorised at: ${date(s.contract.authenticated_at||s.contract.activated_at)}`,'This is the lender-side record of the DebiCheck mandate. It does not claim successful bank authorisation unless the provider status above confirms it.'];
  if(type==='settlement_letter')return[...lenderLines(s),'',`Client: ${[s.profile.first_name,s.profile.last_name].filter(Boolean).join(' ')||'Client'}`,`Loan account: ${s.loan.account_number||'—'}`,`Settlement date: ${date(s.settlement.settlement_date||payload.settlement_date)}`,`Settlement amount received: ${money(s.settlement.settlement_amount||payload.settlement_amount)}`,'','The early-settlement payment was confirmed and the loan account has been closed with an outstanding balance of R0.00.'];
  if(type==='paid_up_letter')return[...lenderLines(s),'',`Client: ${[s.profile.first_name,s.profile.last_name].filter(Boolean).join(' ')||'Client'}`,`Loan account: ${s.loan.account_number||'—'}`,`Date: ${date(new Date())}`,'','This letter confirms that the recorded outstanding balance on this loan is R0.00 and the loan status is paid.'];
  if(type==='statement')return[...lenderLines(s),'','Loan statement','',...statementLines(s)];
  if(type==='notice'){const kind=payload.notice_kind||'general';if(kind==='documents_required')return[...lenderLines(s),'','Documents required',`Document: ${payload.title||payload.document_type||'Supporting document'}`,`Reason: ${payload.reason||'An updated document is required.'}`,'Please upload the requested document through your client portal so the application can continue.'];return[...base,'Overdue notice',`Amount currently due: ${money(s.loan.next_payment_amount)}`,`Outstanding balance: ${money(s.loan.outstanding_balance)}`,'Please make payment or contact the lender if you need to discuss a payment arrangement.'];}
  throw new Error('Unsupported document type.');
}
async function saveDocument(job,buffer){
  const existing=await dbSelect('loan_documents',{select:'id',event_key:`eq.${job.event_key}`,limit:1});if(existing?.[0])return existing[0].id;
  const versions=await dbSelect('loan_documents',{select:'version',user_id:`eq.${job.user_id}`,document_type:`eq.${job.document_type}`,order:'version.desc',limit:1});const version=Number(versions?.[0]?.version||0)+1;
  const path=`${job.user_id}/${job.loan_id||job.application_id||'application'}/${safePath(job.document_type)}/${safePath(job.event_key)}.pdf`;await storageUpload('loan-documents',path,buffer);
  const number=`KR-${String(job.document_type).toUpperCase().replace(/[^A-Z0-9]+/g,'-')}-${String(job.id).slice(0,8).toUpperCase()}`;
  const inserted=await dbInsert('loan_documents',{loan_id:job.loan_id||null,user_id:job.user_id,application_id:job.application_id||null,document_type:job.document_type,title:TITLE[job.document_type],storage_path:path,storage_bucket:'loan-documents',source:'generated',mime_type:'application/pdf',version,document_number:number,event_key:job.event_key,metadata:{job_id:job.id,...(job.payload||{})},generated_at:new Date().toISOString()});return inserted?.[0]?.id;
}
export async function processDocumentJobs(limit=20){
  const jobs=await dbSelect('document_generation_jobs',{select:'*',status:'in.(queued,failed)',available_at:`lte.${new Date().toISOString()}`,order:'created_at.asc',limit});let completed=0,failed=0;
  for(const job of jobs||[]){if(!TYPES.has(job.document_type))continue;try{await dbUpdate('document_generation_jobs',{id:`eq.${job.id}`},{status:'processing',attempts:Number(job.attempts||0)+1,updated_at:new Date().toISOString()});const s=await source(job),lines=documentLines(job.document_type,s,job.payload||{}),buffer=pdfBuffer(TITLE[job.document_type],lines),documentId=await saveDocument(job,buffer);await dbUpdate('document_generation_jobs',{id:`eq.${job.id}`},{status:'completed',document_id:documentId,last_error:null,processed_at:new Date().toISOString(),updated_at:new Date().toISOString()});completed+=1;}catch(error){const attempts=Number(job.attempts||0)+1,terminal=attempts>=5;await dbUpdate('document_generation_jobs',{id:`eq.${job.id}`},{status:'failed',attempts,last_error:String(error.message||error).slice(0,500),available_at:new Date(Date.now()+(terminal?86400000:Math.min(3600000,attempts*300000))).toISOString(),updated_at:new Date().toISOString()}).catch(()=>{});failed+=1;}}
  return{examined:(jobs||[]).length,completed,failed};
}
