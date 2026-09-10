import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { dbRpc, dbSelect } from './supabase-rest.js';

export function validCustomerEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) && !/^kr-[a-f0-9]+@login\.invalid$/i.test(email) ? email : '';
}
export function paymentReference() { return `KR-PAY-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`; }
function isoDate(value = new Date()) { return value.toISOString().slice(0, 10); }
function daysBetween(from,to){return Math.round((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000);}
function roundMoney(value){return Math.round((Number(value)+Number.EPSILON)*100)/100;}

// Kept as a pure helper for tests / previews. Live settlement quotes below are
// always calculated by the database function so every provider uses one source of truth.
export function calculateSettlementAmount({loan,transactions=[],asOf=isoDate()}){
  const paid=transactions.reduce((total,row)=>row.transaction_type==='payment'?total+Number(row.amount||0):row.transaction_type==='refund'?total-Number(row.amount||0):total,0);
  const start=loan.start_date||asOf,due=loan.due_date||asOf,termDays=Math.max(daysBetween(start,due)+1,1),elapsedDays=Math.min(termDays,Math.max(daysBetween(start,asOf)+1,0)),ratio=elapsedDays/termDays;
  const principal=Number(loan.principal_amount||0),initiation=Number(loan.initiation_fee||0),earnedInterest=Number(loan.interest_amount||0)*ratio,earnedServiceFee=Number(loan.service_fee||0)*ratio;
  const amount=roundMoney(Math.min(Number(loan.outstanding_balance),Math.max(principal+initiation+earnedInterest+earnedServiceFee-paid,0)));
  return{amount,components:{principal,initiation_fee:roundMoney(initiation),earned_interest:roundMoney(earnedInterest),earned_service_fee:roundMoney(earnedServiceFee),payments_received:roundMoney(paid),elapsed_days:elapsedDays,term_days:termDays,future_charge_rebate:roundMoney(Math.max(Number(loan.outstanding_balance)-amount,0))}};
}

async function authoritativeSettlement(loanId,asOf){
  const result=await dbRpc('calculate_early_settlement_breakdown',{p_loan_id:loanId,p_as_of:asOf});
  if(!result||typeof result!=='object')throw new HttpError(502,'The settlement calculation could not be completed.','settlement_calculation_failed');
  return{
    amount:Number(result.amount||0),
    components:{
      principal:Number(result.principal||0),
      initiation_fee:Number(result.initiation_fee_earned||0),
      earned_interest:Number(result.interest_earned||0),
      earned_service_fee:Number(result.service_fee_earned||0),
      payments_received:Number(result.paid_to_date||0),
      earned_total:Number(result.earned_total||0),
      current_outstanding_balance:Number(result.current_outstanding_balance||0),
      elapsed_days:Number(result.elapsed_days||0),
      term_days:Number(result.term_days||0),
      future_charge_rebate:Number(result.future_charge_rebate||0)
    }
  };
}

export async function loadPaymentQuote({loanId,userId=null,scheduleId=null,paymentType,asOf=isoDate()}){
  const loans=await dbSelect('loans',{select:'*',id:`eq.${loanId}`,limit:1});const loan=loans?.[0];
  if(!loan||(userId&&loan.user_id!==userId))throw new HttpError(404,'Loan not found.','loan_not_found');
  if(!['active','overdue'].includes(loan.status)||Number(loan.outstanding_balance)<=0)throw new HttpError(409,'This loan does not have an outstanding balance.','loan_not_payable');
  if(loan.payout_status!=='paid')throw new HttpError(409,'This loan cannot accept repayments before its payout is recorded.','loan_not_disbursed');
  const[profiles,schedules]=await Promise.all([dbSelect('customer_profiles',{select:'id,first_name,last_name,mobile,email',id:`eq.${loan.user_id}`,limit:1}),dbSelect('repayment_schedule',{select:'*',loan_id:`eq.${loan.id}`,order:'due_date.asc,instalment_number.asc'})]);
  const profile=profiles?.[0]||null;
  if(paymentType==='instalment'){
    const payable=(schedules||[]).filter(row=>!['paid','waived'].includes(row.status)&&Number(row.amount_due)>Number(row.amount_paid));const schedule=scheduleId?payable.find(row=>row.id===scheduleId):payable[0];
    if(!schedule)throw new HttpError(409,'No unpaid instalment was found for this loan.','instalment_not_payable');
    const amount=roundMoney(Math.min(Number(loan.outstanding_balance),Number(schedule.amount_due)-Number(schedule.amount_paid)));
    return{loan,profile,schedule,amount,paymentType,asOf,dueDate:schedule.due_date,components:{instalment_number:schedule.instalment_number,amount_due:Number(schedule.amount_due),amount_paid:Number(schedule.amount_paid)}};
  }
  if(paymentType!=='settlement')throw new HttpError(400,'Choose instalment or settlement.','invalid_payment_type');
  const settlement=await authoritativeSettlement(loan.id,asOf);if(settlement.amount<=0)throw new HttpError(409,'This loan is already settled.','loan_not_payable');
  return{loan,profile,schedule:null,amount:settlement.amount,paymentType,asOf,dueDate:asOf,components:settlement.components};
}
