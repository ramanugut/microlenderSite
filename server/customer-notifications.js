import nodemailer from 'nodemailer';
import { dbInsert } from './supabase-rest.js';

function emailReady(){return ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','FROM_EMAIL'].every(name=>Boolean(String(process.env[name]||'').trim()));}
function smsReady(){return ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM_NUMBER'].every(name=>Boolean(String(process.env[name]||'').trim()));}
function money(value){return `R${Number(value||0).toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}`;}
function html(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function localMobile(value){let digits=String(value||'').replace(/\D/g,'');if(digits.startsWith('27')&&digits.length===11)digits=`0${digits.slice(2)}`;return digits;}
function internationalMobile(value){const local=localMobile(value);return /^0\d{9}$/.test(local)?`+27${local.slice(1)}`:'';}
async function log({userId,loanId,channel,subject,message,status}){await dbInsert('communication_log',{user_id:userId,loan_id:loanId,channel,direction:'outbound',subject,message,status,created_by:null}).catch(()=>{});}
async function sendEmail({to,subject,text,htmlBody,userId,loanId}){
  if(!emailReady()||!to){await log({userId,loanId,channel:'email',subject,message:text,status:'failed'});return{channel:'email',sent:false,reason:!to?'email_missing':'email_not_configured'};}
  const port=Number(process.env.SMTP_PORT||587);const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:String(process.env.SMTP_SECURE||'').toLowerCase()==='true'||port===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
  await transporter.sendMail({from:process.env.FROM_EMAIL,to,subject,text,html:htmlBody,disableFileAccess:true,disableUrlAccess:true});await log({userId,loanId,channel:'email',subject,message:text,status:'sent'});return{channel:'email',sent:true};
}
async function sendSms({to,message,userId,loanId}){
  const mobile=internationalMobile(to);if(!smsReady()||!mobile){await log({userId,loanId,channel:'sms',subject:'Collection reminder',message,status:'failed'});return{channel:'sms',sent:false,reason:!mobile?'mobile_missing':'sms_not_configured'};}
  const sid=String(process.env.TWILIO_ACCOUNT_SID),auth=Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),body=new URLSearchParams({To:mobile,From:String(process.env.TWILIO_FROM_NUMBER),Body:message});
  const response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,{method:'POST',headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(20000)});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload?.message||'SMS could not be sent.');await log({userId,loanId,channel:'sms',subject:'Collection reminder',message,status:'sent'});return{channel:'sms',sent:true,providerReference:payload?.sid||null};
}
export function notificationCapabilities(){return{emailConfigured:emailReady(),smsConfigured:smsReady()};}
export async function sendPreCollectionReminder({profile,loan,schedule,flow}){
  const name=String(profile?.first_name||'').trim()||'there',amount=Math.max(0,Number(schedule.amount_due||0)-Number(schedule.amount_paid||0)),due=String(schedule.due_date||''),subject=`Upcoming loan instalment - ${due}`;
  const text=`Hi ${name}, a ${money(amount)} instalment for loan ${loan.account_number||''} is scheduled for collection on ${due}. Please make sure sufficient funds are available in your nominated account.`;
  const htmlBody=`<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto"><h2 style="color:#0d6efd">Upcoming collection</h2><p>Hi ${html(name)},</p><p>A <strong>${html(money(amount))}</strong> instalment for loan <strong>${html(loan.account_number||'')}</strong> is scheduled for collection on <strong>${html(due)}</strong>.</p><p>Please make sure sufficient funds are available in your nominated account.</p><p style="font-size:12px;color:#68788a">This is a reminder only. It does not create an additional debit or payment request.</p></div>`;
  const results=[];if(flow.pre_reminder_email)results.push(await sendEmail({to:profile?.email,subject,text,htmlBody,userId:loan.user_id,loanId:loan.id}).catch(error=>({channel:'email',sent:false,error:error.message})));if(flow.pre_reminder_sms)results.push(await sendSms({to:profile?.mobile,message:text,userId:loan.user_id,loanId:loan.id}).catch(error=>({channel:'sms',sent:false,error:error.message})));return results;
}

export async function sendCollectionReminder({profile,loan,schedule,kind,daysPastDue=0}){
  const name=String(profile?.first_name||'').trim()||'there';
  const amount=Math.max(0,Number(schedule.amount_due||0)-Number(schedule.amount_paid||0));
  const account=loan.account_number||'your loan';
  const copy={
    due_tomorrow:{subject:'Loan payment due tomorrow',title:'Payment due tomorrow',text:`Hi ${name}, your ${money(amount)} payment for ${account} is due tomorrow (${schedule.due_date}). Please ensure funds are available or make payment from your client portal.`},
    due_today:{subject:'Loan payment due today',title:'Payment due today',text:`Hi ${name}, your ${money(amount)} payment for ${account} is due today. You can make payment from your client portal.`},
    missed_payment:{subject:'Missed loan payment',title:'Payment overdue',text:`Hi ${name}, we have not received the ${money(amount)} payment due on ${schedule.due_date} for ${account}. Please make payment or contact the lender if you need to make a payment arrangement.`},
    arrears_daily:{subject:'Loan account remains overdue',title:'Account overdue',text:`Hi ${name}, your ${money(amount)} payment for ${account} remains overdue by ${daysPastDue} day${daysPastDue===1?'':'s'}. Please pay from your client portal or contact the lender to discuss a promise-to-pay arrangement.`}
  }[kind];
  if(!copy)throw new Error('Unknown collection reminder type.');
  const htmlBody=`<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto"><h2 style="color:#0d6efd">${html(copy.title)}</h2><p>${html(copy.text)}</p><p style="font-size:12px;color:#68788a">If you have already paid, no further action is required once the payment is confirmed.</p></div>`;
  const results=[];
  if(emailReady()&&profile?.email)results.push(await sendEmail({to:profile.email,subject:copy.subject,text:copy.text,htmlBody,userId:loan.user_id,loanId:loan.id}).catch(error=>({channel:'email',sent:false,error:error.message})));
  if(smsReady()&&profile?.mobile)results.push(await sendSms({to:profile.mobile,message:copy.text,userId:loan.user_id,loanId:loan.id}).catch(error=>({channel:'sms',sent:false,error:error.message})));
  if(!results.length)return[{channel:'none',sent:false,reason:'notifications_not_configured'}];
  return results;
}
