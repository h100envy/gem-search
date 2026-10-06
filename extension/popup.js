const $=s=>document.querySelector(s);
async function send(type,extra={}){const result=await chrome.runtime.sendMessage({type,...extra});if(!result?.ok)throw Error(result?.error||'Extension unavailable');return result;}
async function refresh(){
  const s=await send('get-status');
  $('#connection').textContent=s.engine?'Local engine paired · '+(s.engine.grok?.enabled?'Grok enabled':'local rules'):s.paired?'Paired · engine not reached':'Local engine not paired';
  $('#dot').classList.toggle('ready',!!s.engine);
  $('#captured').textContent=s.engine?.spider?.captured||0;$('#leads').textContent=s.engine?.leads||0;$('#queued').textContent=s.queued;
  const scanner=s.scanner;
  $('#scanner-status').textContent=scanner?.active?(scanner.waiting|| (scanner.expiresAt===null?'Running until you stop it.':'Running until '+new Date(scanner.expiresAt).toLocaleTimeString()+'.')):scanner?.reason==='time-limit'?'Stopped: time limit reached.':'Scanner stopped.';
  $('#stop').disabled=!scanner?.active;
  if(s.lastError)$('#message').textContent=s.lastError;
}
for(const type of ['connect','start','stop','disconnect']){
  $('#'+type).onclick=async()=>{
    const b=$('#'+type);b.disabled=true;
    try{
      await send(type,type==='connect'?{code:$('#pairing').value.trim()}:type==='start'?{autoScroll:$('#auto-scroll').checked,durationMinutes:Number($('#duration').value)}:{});
      $('#message').textContent={connect:'Connected. Open X and release your spider.',start:'Scanner started. Switching tabs or apps does not end it.',stop:'Scanner stopped. Previously queued posts may still be forwarded.',disconnect:'Scanner stopped; pairing and queued posts cleared.'}[type];
      if(type==='connect')$('#pairing').value='';
    }catch(e){$('#message').textContent=e.message;}
    finally{b.disabled=false;await refresh().catch(e=>$('#message').textContent=e.message);}
  };
}
refresh().catch(e=>$('#message').textContent=e.message);
setInterval(()=>refresh().catch(()=>{}),1000);
