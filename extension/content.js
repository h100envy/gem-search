(() => {
  if(globalThis.__gemContent)return;
  let ui=null,timer=null,active=false,busy=false,read=0,scanner=null;
  const seen=new Set();
  function stop(reason='stopped'){
    active=false;clearInterval(timer);timer=null;
    if(ui)ui.update({paused:true,stopped:true,status:reason==='time-limit'?'Time limit reached. Release the spider to start a new session.':'Scanner stopped. Release the spider from the popup to start again.'});
  }
  function stopSession(reason='stopped'){
    stop(reason);
    if(scanner)chrome.runtime.sendMessage({type:'stop-session',sessionId:scanner.id,reason}).catch(()=>{});
  }
  function close(){stopSession();ui?.destroy();ui=null;}
  function start(session){
    if(!session?.active||!GemExtract.supported(location.href))return;
    scanner=session;
    if(!ui)ui=new GemSpiderUI({onPause:()=>stopSession(),onClose:close});
    active=true;ui.update({paused:false,stopped:false,status:session.expiresAt===null?'Scanning until you stop it. Switching tabs does not end this session.':'Scanning until '+new Date(session.expiresAt).toLocaleTimeString()+'.'});
    if(!timer)timer=setInterval(tick,2800);tick();
  }
  async function tick(){
    if(!active||!scanner||busy)return;
    if(scanner.expiresAt!==null&&Date.now()>=scanner.expiresAt){stopSession('time-limit');return;}
    if(!GemExtract.supported(location.href)){close();return;}
    const articles=[...document.querySelectorAll('article[data-testid="tweet"]')];
    const candidates=articles.map(el=>({el,rect:el.getBoundingClientRect()})).filter(x=>x.rect.top>=-80&&x.rect.top<innerHeight-100&&x.rect.bottom>100&&x.rect.width>100).map(x=>({...x,post:GemExtract.extract(x.el)})).filter(x=>x.post&&!seen.has(x.post.id));
    const batch=candidates.slice(0,document.hidden?20:1);
    if(!batch.length){
      // Editing suppresses scrolling on a visible page, not the scanner session.
      const typing=!document.hidden&&document.activeElement?.matches('input,textarea,[contenteditable="true"],[role="textbox"]');
      if(scanner.autoScroll&&!typing)window.scrollBy({top:Math.round(innerHeight*.6),behavior:document.hidden?'instant':'smooth'});
      return;
    }
    busy=true;const sessionId=scanner.id;
    if(!document.hidden)ui?.go(batch[0].rect,'Inspecting this post…');
    try{
      const response=await chrome.runtime.sendMessage({type:'capture',sessionId,posts:batch.map(x=>x.post)});
      if(!active||scanner.id!==sessionId)return;
      if(response?.ok){for(const {post} of batch){seen.add(post.id);if(seen.size>2000)seen.delete(seen.values().next().value);}read+=batch.length;ui?.update({read,status:response.queued?'Saved locally. Forwarding to the research engine.':'Sent to JEV → crawler → Grok.'});}
      else ui?.update({status:response?.error||'Open the extension popup to connect.'});
    }catch{ui?.update({status:'Waiting for the extension. Reopen its popup if the connection does not recover.'});}
    finally{busy=false;}
  }
  chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
    if(message.type==='configure'){start(message.scanner);reply({ok:true});}
    if(message.type==='scanner-tick'){if(scanner?.id===message.sessionId)tick();reply({active:active&&scanner?.id===message.sessionId,read});}
    if(message.type==='stop'){if(!message.sessionId||scanner?.id===message.sessionId)stop(message.reason);reply({ok:true});}
    if(message.type==='status')reply({active,read});
    if(message.type==='engine-status'&&active)ui?.update({leads:message.leads,status:message.status});
  });
  // A reload removes this renderer; the worker retains and restores the session.
  addEventListener('pagehide',()=>{stop();ui?.destroy();ui=null;},{once:true});
  globalThis.__gemContent={stop};
})();
