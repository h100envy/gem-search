import './shared.js';
const BASE='http://127.0.0.1:8787';
let serial=Promise.resolve(),flushing=null,connectionVersion=0;
chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
function exclusive(fn){const p=serial.then(fn,fn);serial=p.catch(()=>{});return p;}
async function backend(path,pairing,body){
  if(!pairing)throw Error('Connect the local engine first.');
  const response=await fetch(BASE+'/api/extension/'+path,{method:body?'POST':'GET',headers:{'X-Gem-Extension':pairing,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error(response.status===403?'Pairing code rejected. Reconnect from the popup.':'Engine HTTP '+response.status);
  return response.json();
}
async function recordError(error){
  await exclusive(async()=>{const {pairing}=await chrome.storage.local.get('pairing');if(pairing)await chrome.storage.local.set({lastError:error.message});});
}
function flush(){
  if(flushing)return flushing;
  flushing=(async()=>{
    const version=connectionVersion;
    const {pairing,queue=[]}=await exclusive(()=>chrome.storage.local.get(['pairing','queue']));
    if(queue.length){
      const chunk=queue.slice(0,20),ids=new Set(chunk.map(p=>p.id));
      await backend('ingest',pairing,{posts:chunk});
      await exclusive(async()=>{
        if(version!==connectionVersion)return;
        const {queue:current=[]}=await chrome.storage.local.get('queue');
        await chrome.storage.local.set({queue:current.filter(p=>!ids.has(p.id)),lastError:''});
      });
    }
    if(version!==connectionVersion)return;
    const status=await backend('status',pairing);
    await exclusive(async()=>{
      if(version!==connectionVersion)return;
      await chrome.storage.local.set({engine:status,lastError:''});
      const {scanner}=await chrome.storage.local.get('scanner');
      if(scanner?.active)chrome.tabs.sendMessage(scanner.tabId,{type:'engine-status',leads:status.leads,status:status.grok?.enabled?'Grok reviews enabled · '+status.spider.pending+' posts queued':'Local research · '+status.spider.pending+' posts queued'}).catch(()=>{});
    });
    return status;
  })().finally(()=>{flushing=null;});
  return flushing;
}
async function finishScanner(reason='stopped'){
  const {scanner}=await chrome.storage.local.get('scanner');
  if(scanner){
    await chrome.storage.local.set({scanner:{...scanner,active:false,reason}});
    await chrome.tabs.sendMessage(scanner.tabId,{type:'stop',sessionId:scanner.id,reason}).catch(()=>{});
  }
  await chrome.alarms.clear('scanner-deadline');
}
async function currentScanner(){
  const {scanner}=await chrome.storage.local.get('scanner');
  if(scanner?.active&&scanner.expiresAt!==null&&Date.now()>=scanner.expiresAt){await finishScanner('time-limit');return {...scanner,active:false,reason:'time-limit'};}
  return scanner;
}
async function wakeScanner(){
  const scanner=await currentScanner();
  if(!scanner?.active)return;
  let tab;
  try{tab=await chrome.tabs.get(scanner.tabId);}catch{await finishScanner('tab-closed');return;}
  if(!GemExtract.supported(tab.url||'')||new URL(tab.url).origin!==scanner.origin){await finishScanner('left-feed');return;}
  if(tab.discarded||tab.frozen||tab.status==='loading'){
    await chrome.storage.local.set({scanner:{...scanner,waiting:'Feed tab is unloaded; restore it to continue.'}});return;
  }
  try{
    const response=await chrome.tabs.sendMessage(scanner.tabId,{type:'scanner-tick',sessionId:scanner.id});
    if(!response?.active)throw Error('Content script needs configuration');
  }catch{
    try{
      await chrome.scripting.executeScript({target:{tabId:scanner.tabId},files:['shared.js','spider-ui.js','content.js']});
      await chrome.tabs.sendMessage(scanner.tabId,{type:'configure',scanner});
    }catch{
      await chrome.storage.local.set({scanner:{...scanner,waiting:'Cannot reach the feed. Open that tab and release the spider again.'}});return;
    }
  }
  if(scanner.waiting)await chrome.storage.local.set({scanner:{...scanner,waiting:''}});
}
// Alarms may disappear after a browser restart. Recreate them on worker wake.
exclusive(async()=>{
  if(!await chrome.alarms.get('flush'))await chrome.alarms.create('flush',{periodInMinutes:1});
  if(!await chrome.alarms.get('scanner-tick'))await chrome.alarms.create('scanner-tick',{periodInMinutes:1});
  const scanner=await currentScanner();
  if(scanner?.active&&scanner.expiresAt!==null)await chrome.alarms.create('scanner-deadline',{when:scanner.expiresAt});
}).catch(recordError);
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name==='flush')flush().catch(recordError);
  if(alarm.name==='scanner-tick'||alarm.name==='scanner-deadline')exclusive(wakeScanner).catch(recordError);
});
chrome.tabs.onRemoved.addListener(tabId=>exclusive(async()=>{const scanner=await currentScanner();if(scanner?.active&&scanner.tabId===tabId)await finishScanner('tab-closed');}).catch(recordError));
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(change.status==='complete'||change.url)exclusive(async()=>{const scanner=await currentScanner();if(scanner?.active&&scanner.tabId===tabId)await wakeScanner();}).catch(recordError);
});
// Tab IDs and activeTab grants are not a durable identity across browser restarts.
chrome.runtime.onStartup.addListener(()=>exclusive(()=>finishScanner('browser-restarted')).catch(recordError));
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  const ui=!sender.tab&&sender.url?.startsWith(chrome.runtime.getURL(''));
  const task=async()=>{
    if(message.type==='capture'){
      const scanner=await currentScanner();
      if(!scanner?.active||sender.tab?.id!==scanner.tabId||message.sessionId!==scanner.id)throw Error('Scanner session is stopped.');
      if(!GemExtract.supported(sender.tab.url||sender.url))throw Error('Capture is supported only on X feed pages.');
      if(!Array.isArray(message.posts)||message.posts.length>20)throw Error('Invalid capture batch');
      const posts=message.posts.map(GemExtract.normalize).filter(Boolean);
      const {queue=[]}=await chrome.storage.local.get('queue');
      const ids=new Set(queue.map(p=>p.id));const fresh=posts.filter(p=>!ids.has(p.id));
      if(queue.length+fresh.length>200)throw Error('Local queue full. Start the engine before continuing.');
      await chrome.storage.local.set({queue:[...queue,...fresh]});return {ok:true,queued:true};
    }
    if(message.type==='stop-session'){
      const scanner=await currentScanner();
      if(scanner?.active&&sender.tab?.id===scanner.tabId&&message.sessionId===scanner.id)await finishScanner(message.reason==='time-limit'?'time-limit':'stopped');
      return {ok:true};
    }
    if(!ui)throw Error('Popup-only action');
    if(message.type==='connect'){
      if(typeof message.code!=='string'||!/^[A-Za-z0-9_-]{40,100}$/.test(message.code))throw Error('Paste the pairing code from the dashboard.');
      connectionVersion++;await chrome.storage.local.set({pairing:message.code});return {ok:true};
    }
    if(message.type==='start'){
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      if(!tab||!GemExtract.supported(tab.url))throw Error('Open an X feed or search page first.');
      const minutes=message.durationMinutes??0;
      if(!Number.isInteger(minutes)||minutes<0||minutes>1440)throw Error('Choose until stopped, or a time limit from 1 to 1440 minutes.');
      await finishScanner();
      const scanner={id:crypto.randomUUID(),tabId:tab.id,origin:new URL(tab.url).origin,active:true,autoScroll:message.autoScroll===true,startedAt:Date.now(),expiresAt:minutes?Date.now()+minutes*60000:null,waiting:''};
      await chrome.storage.local.set({scanner});
      if(scanner.expiresAt!==null)await chrome.alarms.create('scanner-deadline',{when:scanner.expiresAt});
      try{
        await chrome.scripting.executeScript({target:{tabId:tab.id},files:['shared.js','spider-ui.js','content.js']});
        await chrome.tabs.sendMessage(tab.id,{type:'configure',scanner});
      }catch(error){await finishScanner('start-failed');throw error;}
      return {ok:true,scanner};
    }
    if(message.type==='stop'){await finishScanner();return {ok:true};}
    if(message.type==='disconnect'){
      await finishScanner('disconnected');connectionVersion++;
      await chrome.storage.local.remove(['pairing','queue','engine']);return {ok:true};
    }
    if(message.type==='get-status'){
      const scanner=await currentScanner();
      const {queue=[],engine,lastError,pairing}=await chrome.storage.local.get(['queue','engine','lastError','pairing']);
      return {ok:true,paired:!!pairing,queued:queue.length,engine,lastError,scanner};
    }
    throw Error('Unknown action');
  };
  exclusive(task).then(async result=>{
    if(message.type==='connect')return reply({...result,engine:await flush()});
    reply(result);
    if(message.type==='capture')flush().catch(recordError);
  }).catch(e=>reply({ok:false,error:e.message}));return true;
});
