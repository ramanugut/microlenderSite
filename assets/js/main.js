(() => {
  const current=(window.location.pathname.split('/').pop()||'index.html').toLowerCase();
  const isAccount=current==='account.html';
  const startLoanHref='index.html#loan-calculator';

  const loadStyle=(href,attribute,value)=>{
    if(document.querySelector(`link[${attribute}]`))return;
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href=href;
    link.setAttribute(attribute,value);
    document.head.appendChild(link);
  };

  loadStyle('assets/css/theme.css','data-kredrun-theme','premium');
  loadStyle('assets/css/site-polish.css','data-kredrun-site-polish','shared');
  if(current==='index.html'){
    loadStyle('assets/css/homepage.css','data-kredrun-home','premium');
    loadStyle('assets/css/calculator.css','data-kredrun-calculator','collection-date');
    loadStyle('assets/css/home-compact.css','data-kredrun-home-compact','above-fold');
  }

  if(['about.html','help.html','quick-loans.html','why-us.html','news.html','careers.html','trust-rating.html','privacy.html','terms.html','code-of-practice.html'].includes(current)){
    document.body.classList.add('compact-info-page');
  }

  const icon=`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 3h4v7l6-7h5l-7.6 8.2L21 21h-5.2L9 13.2V21H5z"/></svg>`;
  const brand=`<a class="brand" href="index.html" aria-label="KredRun home"><span class="brand-mark">${icon}</span><span>Kred<em>Run</em></span></a>`;
  const nav=[['quick-loans.html','How it works'],['why-us.html','Why KredRun'],['help.html','Help']];
  const navLinks=nav.map(([href,label])=>`<a class="nav-link ${current===href?'active':''}" href="${href}">${label}</a>`).join('');

  const header=document.querySelector('[data-site-header]');
  if(header){
    const actions=isAccount
      ? `<div class="nav-actions portal-global-actions"><a class="nav-link" href="help.html">Help</a></div>`
      : `<div class="nav-actions"><a class="btn btn-outline" href="about.html">About us</a><a class="nav-link ${current==='login.html'?'active':''}" href="login.html">Log in</a><a class="btn btn-primary" href="${startLoanHref}">Apply now</a><button class="menu-btn" type="button" aria-label="Open menu" aria-expanded="false"><span></span></button></div>`;
    const mobile=isAccount
      ? `<div class="mobile-panel" aria-hidden="true"><div class="container"><a href="help.html">Help</a><a href="index.html">KredRun home</a></div></div>`
      : `<div class="mobile-panel" aria-hidden="true"><div class="container">${navLinks}<a href="about.html">About us</a><a href="login.html">Log in</a><a class="btn btn-primary" href="${startLoanHref}">Apply now</a></div></div>`;
    header.innerHTML=`<div class="top-strip"><div class="container"><strong>Fast. Simple. Responsible.</strong><span>Clear online credit for South Africans.</span></div></div><header class="site-header"><div class="container nav-wrap">${brand}<nav class="desktop-nav" aria-label="Main navigation">${isAccount?'':navLinks}</nav>${actions}</div></header>${mobile}`;
  }

  const footer=document.querySelector('[data-site-footer]');
  if(footer){
    footer.innerHTML=`<footer class="site-footer"><div class="container"><div class="footer-grid" style="grid-template-columns:1.35fr 1fr 1fr"><div class="footer-brand">${brand}<p>Simple short-term credit with a clear application and account journey.</p></div><div class="footer-col"><h4>Customer</h4><a href="quick-loans.html">How it works</a><a href="help.html">Help</a><a href="login.html">Log in</a></div><div class="footer-col"><h4>Legal</h4><a href="code-of-practice.html">Code of Practice</a><a href="privacy.html">Privacy</a><a href="terms.html">Terms of Use</a></div></div><div class="footer-bottom"><span>© ${new Date().getFullYear()} KredRun.</span><span>Credit is subject to affordability assessment and approval.</span></div></div></footer>`;
  }

  const menuButton=document.querySelector('.menu-btn'),mobilePanel=document.querySelector('.mobile-panel');
  if(menuButton&&mobilePanel){
    const closeMenu=()=>{
      mobilePanel.classList.remove('open');
      document.body.classList.remove('menu-open');
      menuButton.setAttribute('aria-expanded','false');
      mobilePanel.setAttribute('aria-hidden','true');
    };
    menuButton.addEventListener('click',()=>{
      const open=mobilePanel.classList.toggle('open');
      document.body.classList.toggle('menu-open',open);
      menuButton.setAttribute('aria-expanded',String(open));
      mobilePanel.setAttribute('aria-hidden',String(!open));
    });
    mobilePanel.querySelectorAll('a').forEach(link=>link.addEventListener('click',closeMenu));
  }

  if(current==='login.html'){
    const params=new URLSearchParams(location.search);
    const applying=String(params.get('next')||'').includes('apply.html');
    const heading=document.querySelector('.auth-simple-head h1');
    const copy=document.querySelector('.auth-simple-head p');
    if(heading)heading.textContent=applying?'Continue application':'Log in';
    if(copy)copy.textContent='Enter your South African ID number.';
    document.title=applying?'Continue application | KredRun':'Log in | KredRun';
  }

  const moneyWhole=new Intl.NumberFormat('en-ZA',{style:'currency',currency:'ZAR',maximumFractionDigits:0});
  const moneyCents=new Intl.NumberFormat('en-ZA',{style:'currency',currency:'ZAR',minimumFractionDigits:2,maximumFractionDigits:2});
  const dateLabel=new Intl.DateTimeFormat('en-ZA',{day:'2-digit',month:'short',year:'numeric'});
  const money=value=>moneyWhole.format(Number(value||0)).replace('ZAR','R').trim();
  const money2=value=>moneyCents.format(Number(value||0)).replace('ZAR','R').trim();
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
  const localISO=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const atMidnight=date=>new Date(date.getFullYear(),date.getMonth(),date.getDate());
  const addDays=(date,days)=>{const next=new Date(date);next.setDate(next.getDate()+days);return next;};
  const addMonthsClamped=(date,months)=>{
    const day=date.getDate();
    const target=new Date(date.getFullYear(),date.getMonth()+months,1);
    const last=new Date(target.getFullYear(),target.getMonth()+1,0).getDate();
    target.setDate(Math.min(day,last));
    return target;
  };
  const dayDiff=(from,to)=>Math.max(1,Math.round((atMidnight(to)-atMidnight(from))/86400000));

  function initHomepageCalculator(){
    const calculator=document.querySelector('[data-loan-planner]');
    if(!calculator)return;

    const today=atMidnight(new Date());
    const maximumDate=addMonthsClamped(today,6);
    const maximumDays=dayDiff(today,maximumDate);
    const defaultDays=Math.min(30,maximumDays);
    const PRICING={monthlyInterestRate:.05,initiationBase:165,initiationPercentAbove1000:.10,initiationMaximum:1050,monthlyServiceFee:60,creditLifePer1000PerMonth:4.50,averageDaysPerMonth:365.25/12};

    calculator.classList.add('collection-calculator','compact-loan-calculator');
    calculator.innerHTML=`
      <div class="compact-calc-head"><span>Loan calculator</span><strong>Up to R8 000 · 6 months</strong></div>
      <section class="compact-control" aria-labelledby="amountControlTitle">
        <div class="compact-control-row"><span id="amountControlTitle">Amount</span><label class="compact-amount-editor" aria-label="Loan amount"><span>R</span><input data-amount-input type="number" inputmode="numeric" min="500" max="8000" step="1" value="2500"></label></div>
        <input data-amount-range class="wheel-range compact-range" type="range" min="500" max="8000" step="50" value="2500" aria-label="Loan amount slider">
        <div class="compact-range-ends"><span>R500</span><span>R8 000</span></div>
      </section>
      <section class="compact-control" aria-labelledby="dateControlTitle">
        <div class="compact-control-row"><span id="dateControlTitle">Collection date</span><strong class="compact-date-value" data-collection-date aria-live="polite">—</strong></div>
        <input data-date-range class="wheel-range compact-range" type="range" min="1" max="${maximumDays}" step="1" value="${defaultDays}" aria-label="Preferred collection date">
        <div class="compact-range-ends"><span>Tomorrow</span><span>6 months</span></div>
      </section>
      <div class="compact-result" aria-label="Estimated repayment"><div><span>Estimated repayment</span><strong data-total-repay>—</strong></div><button class="compact-fees-button" type="button" data-fee-open aria-label="Show interest and fee breakdown"><span>Interest & fees ⓘ</span><strong data-interest-fees>—</strong></button></div>
      <a class="btn btn-primary btn-wide calculator-cta" href="apply.html">Continue application <span aria-hidden="true">→</span></a>
      <dialog class="fee-dialog" data-fee-dialog aria-labelledby="feeDialogTitle">
        <div class="fee-dialog-head"><strong id="feeDialogTitle">Estimated fees</strong><button class="fee-dialog-close" type="button" data-fee-close aria-label="Close fee breakdown">×</button></div>
        <div class="fee-dialog-total" data-fee-dialog-total>—</div>
        <dl class="fee-breakdown-list">
          <div class="fee-breakdown-row"><dt>Initiation fee</dt><dd data-fee-initiation>—</dd></div>
          <div class="fee-breakdown-row"><dt>Service fee</dt><dd data-fee-service>—</dd></div>
          <div class="fee-breakdown-row"><dt>Credit life estimate</dt><dd data-fee-insurance>—</dd></div>
          <div class="fee-breakdown-row total-row"><dt>Total fees</dt><dd data-fee-total>—</dd></div>
          <div class="fee-breakdown-row"><dt>Interest</dt><dd data-fee-interest>—</dd></div>
          <div class="fee-breakdown-row total-row"><dt>Total to repay</dt><dd data-fee-repay>—</dd></div>
        </dl>
        <p class="fee-dialog-note">This is an estimate only. Your final costs are shown before you accept an approved loan.</p>
      </dialog>`;

    const amountRange=calculator.querySelector('[data-amount-range]');
    const amountInput=calculator.querySelector('[data-amount-input]');
    const dateRange=calculator.querySelector('[data-date-range]');
    const collectionDateText=calculator.querySelector('[data-collection-date]');
    const totalRepayText=calculator.querySelector('[data-total-repay]');
    const interestFeesText=calculator.querySelector('[data-interest-fees]');
    const feeDialog=calculator.querySelector('[data-fee-dialog]');

    const setRangeProgress=range=>{
      const min=Number(range.min)||0,max=Number(range.max)||100,value=Number(range.value);
      const progress=max===min?0:((value-min)/(max-min))*100;
      range.style.setProperty('--range-progress',`${clamp(progress,0,100)}%`);
    };

    const calculate=()=>{
      const amount=clamp(Math.round(Number(amountInput.value)||500),500,8000);
      amountInput.value=String(amount);
      amountRange.value=String(amount);
      const days=clamp(Math.round(Number(dateRange.value)||1),1,maximumDays);
      const collectionDate=addDays(today,days);
      const months=days/PRICING.averageDaysPerMonth;
      const initiation=Math.min(PRICING.initiationMaximum,PRICING.initiationBase+Math.max(0,amount-1000)*PRICING.initiationPercentAbove1000);
      const service=PRICING.monthlyServiceFee*months;
      const insurance=(amount/1000)*PRICING.creditLifePer1000PerMonth*months;
      const interest=amount*PRICING.monthlyInterestRate*months;
      const totalFees=initiation+service+insurance;
      const interestAndFees=totalFees+interest;
      const totalRepay=amount+interestAndFees;
      const term=Math.min(6,Math.max(1,Math.ceil(months)));
      const formattedDate=dateLabel.format(collectionDate);

      collectionDateText.textContent=formattedDate;
      totalRepayText.textContent=money2(totalRepay);
      interestFeesText.textContent=money2(interestAndFees);
      calculator.querySelector('[data-fee-dialog-total]').textContent=`${money2(totalRepay)} due on ${formattedDate}`;
      calculator.querySelector('[data-fee-initiation]').textContent=money2(initiation);
      calculator.querySelector('[data-fee-service]').textContent=money2(service);
      calculator.querySelector('[data-fee-insurance]').textContent=money2(insurance);
      calculator.querySelector('[data-fee-total]').textContent=money2(totalFees);
      calculator.querySelector('[data-fee-interest]').textContent=money2(interest);
      calculator.querySelector('[data-fee-repay]').textContent=money2(totalRepay);
      setRangeProgress(amountRange);
      setRangeProgress(dateRange);
      try{localStorage.setItem('kredrun-loan-plan',JSON.stringify({amount,term,collectionDate:localISO(collectionDate),days,estimatedTotal:Number(totalRepay.toFixed(2))}));}catch(_){ }
    };

    amountRange.addEventListener('input',()=>{amountInput.value=amountRange.value;calculate();});
    amountInput.addEventListener('input',()=>{const raw=Number(amountInput.value);if(Number.isFinite(raw)&&raw>=500&&raw<=8000){amountRange.value=String(raw);calculate();}});
    amountInput.addEventListener('change',()=>{amountInput.value=String(clamp(Math.round(Number(amountInput.value)||500),500,8000));calculate();});
    dateRange.addEventListener('input',calculate);
    calculator.querySelector('[data-fee-open]').addEventListener('click',()=>{if(typeof feeDialog.showModal==='function')feeDialog.showModal();else feeDialog.setAttribute('open','');});
    calculator.querySelector('[data-fee-close]').addEventListener('click',()=>feeDialog.close());
    feeDialog.addEventListener('click',event=>{if(event.target===feeDialog)feeDialog.close();});
    calculate();
  }

  function enforceApplicationProductLimit(){
    if(current!=='apply.html')return;
    const amount=document.querySelector('#loanAmount');
    if(!amount)return;
    amount.max='8000';
    if(Number(amount.value)>8000)amount.value='8000';
    const labels=amount.parentElement?.querySelector('.range-minmax');
    if(labels?.lastElementChild)labels.lastElementChild.textContent='R8 000';
    try{const plan=JSON.parse(localStorage.getItem('kredrun-loan-plan')||'null');if(plan?.amount>8000){plan.amount=8000;localStorage.setItem('kredrun-loan-plan',JSON.stringify(plan));}}catch(_){ }
  }

  // Any general "new application" link first returns to the calculator. The calculator's own CTA continues to apply.html.
  document.addEventListener('click',event=>{
    const link=event.target.closest('a[href="apply.html"]');
    if(!link||link.closest('[data-loan-planner]')||current==='apply.html')return;
    event.preventDefault();
    window.location.href=startLoanHref;
  });

  initHomepageCalculator();
  enforceApplicationProductLimit();
})();