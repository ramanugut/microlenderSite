(() => {
  'use strict';
  if(window.__kredrunSettlementLettersLoaded)return;window.__kredrunSettlementLettersLoaded=true;
  const client=window.kredrunSupabase,host=document.querySelector('[data-loan-detail-content]');if(!client||!host)return;
  let currentLoanId=null,timer=null;
  async function token(){const{data}=await client.auth.getSession();if(!data?.session?.access_token)throw new Error('Please sign in again.');return data.session.access_token;}
  function normalizePaymentCopy(){host.querySelectorAll('.loan-payment-actions p').forEach(p=>{if(/paystack/i.test(p.textContent||''))p.textContent='Your lender’s active payment provider handles instalment payments and early settlement securely. Your balance changes only after the provider confirms payment.';});}
  async function decorate(){
    normalizePaymentCopy();
    if(!currentLoanId||host.querySelector('[data-settlement-letter-section]'))return;
    try{const response=await fetch(`/api/settlement-letter?action=list&loanId=${encodeURIComponent(currentLoanId)}`,{headers:{Authorization:`Bearer ${await token()}`},signal:AbortSignal.timeout(12000)});const payload=await response.json().catch(()=>({}));if(!response.ok||!payload.ok||!payload.letters?.length)return;const section=document.createElement('section');section.className='portal-subsection';section.dataset.settlementLetterSection='';section.innerHTML=`<h3>Settlement letter</h3><div class="document-list">${payload.letters.map(letter=>`<button class="document-row" type="button" data-open-settlement-letter="${letter.id}"><span><strong>Loan settlement confirmation</strong><small>${letter.letter_number} · ${letter.settlement_date}</small></span><b>Open</b></button>`).join('')}</div>`;host.append(section);}catch(error){console.warn('Settlement letter could not be loaded',error);}
  }
  async function openLetter(button){
    if(button.dataset.loading==='true')return;button.dataset.loading='true';button.disabled=true;const old=button.querySelector('b')?.textContent;
    try{if(button.querySelector('b'))button.querySelector('b').textContent='Opening…';const response=await fetch(`/api/settlement-letter?action=view&id=${encodeURIComponent(button.dataset.openSettlementLetter)}`,{headers:{Authorization:`Bearer ${await token()}`},signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('Settlement letter could not be opened.');const html=await response.text(),url=URL.createObjectURL(new Blob([html],{type:'text/html'}));window.open(url,'_blank','noopener,noreferrer');setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(error){alert(error.message||'Settlement letter could not be opened.');}finally{delete button.dataset.loading;button.disabled=false;if(button.querySelector('b'))button.querySelector('b').textContent=old||'Open';}
  }
  document.addEventListener('click',event=>{const view=event.target.closest('[data-view-loan]');if(view){currentLoanId=view.dataset.viewLoan;clearTimeout(timer);timer=setTimeout(decorate,250);return;}const letter=event.target.closest('[data-open-settlement-letter]');if(letter){event.preventDefault();openLetter(letter);}});
  new MutationObserver(()=>{normalizePaymentCopy();clearTimeout(timer);timer=setTimeout(decorate,120);}).observe(host,{childList:true,subtree:true});
})();
