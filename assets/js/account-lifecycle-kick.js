(() => {
  'use strict';
  if(window.__kredrunAccountLifecycleKickLoaded)return;window.__kredrunAccountLifecycleKickLoaded=true;
  const client=window.kredrunSupabase;if(!client)return;
  async function kick(){try{const{data}=await client.auth.getSession();const token=data?.session?.access_token;if(!token)return;await fetch('/api/lifecycle',{method:'POST',headers:{Authorization:`Bearer ${token}`},keepalive:true,signal:AbortSignal.timeout(25000)});}catch(error){console.warn('Account lifecycle processing will retry automatically.',error);}}
  setTimeout(kick,900);
  document.addEventListener('click',event=>{if(event.target.closest('[data-pay-loan],[data-settle-loan]'))setTimeout(kick,3500);});
})();
