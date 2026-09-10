(() => {
  'use strict';
  if(window.__kredrunSessionSecurityLoaded)return;window.__kredrunSessionSecurityLoaded=true;
  const client=window.kredrunSupabase;if(!client)return;
  const isStaff=document.body?.classList.contains('admin-page');
  const protectedPage=isStaff||document.body?.classList.contains('account-page')||document.body?.classList.contains('application-page');
  if(!protectedPage)return;
  const timeoutMs=(isStaff?30:60)*60*1000,warningMs=2*60*1000,key=isStaff?'kredrun-staff-last-activity':'kredrun-client-last-activity';
  let warned=false,lastWrite=0;
  function now(){return Date.now();}
  function read(){const value=Number(localStorage.getItem(key)||0);return Number.isFinite(value)&&value>0?value:now();}
  function touch(force=false){const t=now();if(!force&&t-lastWrite<15000)return;lastWrite=t;localStorage.setItem(key,String(t));warned=false;}
  function warning(){if(warned)return;warned=true;let region=document.querySelector('[data-toast-region]');if(!region){region=document.createElement('div');region.className='toast-region';region.dataset.toastRegion='';document.body.append(region);}const item=document.createElement('div');item.className='toast error';item.textContent='Your secure session will end soon because there has been no activity.';region.append(item);setTimeout(()=>item.remove(),12000);}
  async function expire(){try{await client.auth.signOut({scope:'local'});}catch{}const next=location.pathname.split('/').pop()||'account.html';location.replace(`login.html?next=${encodeURIComponent(next)}&reason=inactive`);}
  function check(){const idle=now()-read();if(idle>=timeoutMs)return expire();if(idle>=timeoutMs-warningMs)warning();}
  ['pointerdown','keydown','touchstart','scroll'].forEach(name=>addEventListener(name,()=>touch(false),{passive:true}));
  addEventListener('storage',event=>{if(event.key===key)warned=false;});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){check();touch(false);}});
  touch(!localStorage.getItem(key));setInterval(check,30000);check();
})();
