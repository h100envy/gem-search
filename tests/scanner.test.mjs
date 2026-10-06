import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shared=fs.readFileSync(new URL('../extension/shared.js',import.meta.url),'utf8');
const background=fs.readFileSync(new URL('../extension/background.js',import.meta.url),'utf8').replace("import './shared.js';",'');
const content=fs.readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function clock(time=1700000000000){
  const c={time};c.Date=class extends Date{constructor(...args){super(...(args.length?args:[c.time]));}static now(){return c.time;}};return c;
}
function worker({store={},time=clock(),fetcher}={}){
  const hooks={},alarms=new Map(),sent=[],injected=[];
  const tab={id:7,url:'https://x.com/home',status:'complete',discarded:false};
  let activeTab=tab,contentActive=true,sequence=0;
  const event=name=>({addListener:callback=>hooks[name]=callback});
  const chrome={
    storage:{local:{
      setAccessLevel:async()=>{},
      get:async keys=>Object.fromEntries((typeof keys==='string'?[keys]:keys).map(k=>[k,structuredClone(store[k])])),
      set:async values=>Object.assign(store,structuredClone(values)),
      remove:async keys=>{for(const key of keys)delete store[key];}
    }},
    alarms:{get:async name=>alarms.get(name),create:async(name,options)=>alarms.set(name,options),clear:async name=>alarms.delete(name),onAlarm:event('alarm')},
    tabs:{
      query:async()=>[activeTab],get:async id=>{if(id!==tab.id||tab.closed)throw Error('Tab closed');return tab;},
      sendMessage:async(id,message)=>{sent.push({id,message});if(message.type==='configure')contentActive=true;return {ok:true,active:contentActive};},
      onRemoved:event('removed'),onUpdated:event('updated')
    },
    scripting:{executeScript:async options=>{injected.push(options);}},
    runtime:{getURL:path=>'chrome-extension://test/'+path,onMessage:event('message'),onStartup:event('startup')}
  };
  const context=vm.createContext({chrome,Date:time.Date,URL,AbortSignal,crypto:{randomUUID:()=>String(++sequence)},fetch:fetcher|| (async()=>{throw Error('offline');})});
  vm.runInContext(shared,context);vm.runInContext(background,context);
  return {store,time,tab,sent,injected,hooks,alarms,
    message:(message,sender={url:'chrome-extension://test/popup.html'})=>new Promise(resolve=>hooks.message(message,sender,resolve)),
    alarm:async name=>{hooks.alarm({name});await settle();},
    switchTab:()=>{activeTab={id:99,url:'https://example.com/'};},
    unload:()=>{contentActive=false;}
  };
}
const post=i=>({url:`https://x.com/researcher/status/${i}`,text:'AI agent evaluation release',created_at:'2023-11-14T12:00:00Z',links:[]});
const capture=w=>({type:'capture',sessionId:w.store.scanner.id,posts:[post(123)]});
const sender=w=>({tab:w.tab,url:w.tab.url});

test('until-stopped session remains bound to original tab after switching tabs',async()=>{
  const w=worker();await w.message({type:'start',autoScroll:true});w.switchTab();await w.alarm('scanner-tick');
  assert.equal(w.store.scanner.active,true);assert.equal(w.store.scanner.expiresAt,null);
  assert.equal(w.sent.at(-1).id,7);
  assert.equal((await w.message(capture(w),sender(w))).ok,true);
  await w.message({type:'stop'});
  assert.equal(w.store.scanner.active,false);assert.equal(w.sent.at(-1).id,7);
  assert.equal((await w.message(capture(w),sender(w))).ok,false);
});
test('deadline rejects captures at expiry even when browser alarms are delayed',async()=>{
  const w=worker();await w.message({type:'start',durationMinutes:15});
  assert.equal(w.alarms.get('scanner-deadline').when,w.time.time+15*60000);
  w.time.time+=15*60000;
  assert.equal((await w.message(capture(w),sender(w))).ok,false);
  assert.equal(w.store.scanner.reason,'time-limit');assert.equal(w.alarms.has('scanner-deadline'),false);
});
test('worker recreation restores alarms and session without extending its deadline',async()=>{
  const store={},time=clock();const first=worker({store,time});await first.message({type:'start',durationMinutes:30});
  const deadline=store.scanner.expiresAt;time.time+=5*60000;
  const second=worker({store,time});await settle();await second.alarm('scanner-tick');
  assert.equal(store.scanner.active,true);assert.equal(store.scanner.expiresAt,deadline);
  assert.equal(second.alarms.get('scanner-deadline').when,deadline);
  time.time=deadline;await second.alarm('scanner-deadline');assert.equal(store.scanner.active,false);
});
test('reload reinjects selected feed while discarded tab waits and explicit stop cannot resurrect',async()=>{
  const w=worker();await w.message({type:'start'});w.unload();
  w.tab.discarded=true;await w.alarm('scanner-tick');assert.equal(w.injected.length,1);assert.equal(w.store.scanner.active,true);assert.match(w.store.scanner.waiting,/unloaded/);
  w.tab.discarded=false;w.hooks.updated(7,{status:'complete'});await settle();
  assert.equal(w.injected.length,2);assert.equal(w.store.scanner.waiting,'');
  await w.message({type:'stop'});w.unload();await w.alarm('scanner-tick');assert.equal(w.injected.length,2);
});
test('leaving feed, closing selected tab and browser restart end the bound session',async()=>{
  for(const action of ['route','close','restart']){
    const w=worker();await w.message({type:'start'});
    if(action==='route'){w.tab.url='https://x.com/messages/123';await w.alarm('scanner-tick');}
    if(action==='close'){w.hooks.removed(7);await settle();}
    if(action==='restart'){w.hooks.startup();await settle();}
    assert.equal(w.store.scanner.active,false,action);
  }
});
test('unrelated tabs and stale sessions cannot capture or stop selected scanner',async()=>{
  const w=worker();await w.message({type:'start'});
  assert.equal((await w.message(capture(w),{tab:{id:99,url:'https://x.com/home'}})).ok,false);
  assert.equal((await w.message({...capture(w),sessionId:'stale'},sender(w))).ok,false);
  await w.message({type:'stop-session',sessionId:w.store.scanner.id},{tab:{id:99}});
  assert.equal(w.store.scanner.active,true);
  await w.message({type:'stop-session',sessionId:w.store.scanner.id},sender(w));assert.equal(w.store.scanner.active,false);
});
test('invalid durations do not replace running session',async()=>{
  const w=worker();await w.message({type:'start'});const id=w.store.scanner.id;
  for(const durationMinutes of [-1,1.5,1441,'15',NaN])assert.equal((await w.message({type:'start',durationMinutes})).ok,false);
  assert.equal(w.store.scanner.id,id);assert.equal(w.store.scanner.active,true);
});
test('slow backend cannot block stop and acknowledgement preserves newer queued posts',async()=>{
  let release;const requests=[];
  const w=worker({store:{pairing:'a'.repeat(43)},fetcher:async(url,options)=>{
    requests.push(url);
    if(url.endsWith('ingest'))await new Promise(resolve=>release=resolve);
    return {ok:true,json:async()=>({spider:{pending:0},leads:0,grok:{enabled:false}})};
  }});
  await w.message({type:'start'});await w.message(capture(w),sender(w));await settle();
  assert.equal(requests.length,1);
  await w.message({...capture(w),posts:[post(456)]},sender(w));
  await w.message({type:'stop'});assert.equal(w.store.scanner.active,false);
  release();await settle();assert.deepEqual(w.store.queue.map(p=>p.id),['456']);
});
test('disconnect stops collection and ignores an old in-flight flush response',async()=>{
  let release;
  const w=worker({store:{pairing:'a'.repeat(43)},fetcher:async()=>{await new Promise(resolve=>release=resolve);return {ok:true,json:async()=>({spider:{pending:0},leads:0})};}});
  await w.message({type:'start'});await w.message(capture(w),sender(w));await settle();
  await w.message({type:'disconnect'});release();await settle();
  assert.equal(w.store.scanner.active,false);assert.equal(w.store.engine,undefined);assert.equal(w.store.queue,undefined);
});

function renderer({hidden=false,typing=false}={}){
  const time=clock(),sent=[],scrolls=[],hooks={},updates=[];let handler,interval,articles=[],fail=false;
  const document={hidden,activeElement:{matches:()=>typing},querySelectorAll:()=>articles};
  const chrome={runtime:{onMessage:{addListener:fn=>handler=fn},sendMessage:async m=>{sent.push(m);if(fail)throw Error('worker temporarily unavailable');return {ok:true,queued:true};}}};
  const context=vm.createContext({chrome,document,location:{href:'https://x.com/home'},Date:time.Date,innerHeight:900,window:{scrollBy:options=>scrolls.push(options)},
    setInterval:fn=>{interval=fn;return 1;},clearInterval:()=>{interval=null;},addEventListener:(name,fn)=>hooks[name]=fn,
    GemExtract:{supported:url=>url==='https://x.com/home',extract:el=>el.post},
    GemSpiderUI:class{constructor(options){hooks.ui=options;}update(values){updates.push(values);}go(){}destroy(){}}
  });
  vm.runInContext(content,context);
  const message=m=>handler(m,{},()=>{});
  return {time,sent,scrolls,hooks,updates,document,context,message,
    setArticles:posts=>{articles=posts.map(post=>({post,getBoundingClientRect:()=>({top:100,bottom:500,width:500})}));},
    tick:async()=>{interval?.();await settle();},
    fail:()=>fail=true,recover:()=>fail=false,
    start:async(expiresAt=null,autoScroll=false)=>{message({type:'configure',scanner:{id:'session',active:true,expiresAt,autoScroll}});await settle();}
  };
}
test('hidden feed captures a bounded viewport batch and survives visibility changes',async()=>{
  const r=renderer({hidden:true});r.setArticles(Array.from({length:25},(_,i)=>({id:String(i)})));await r.start();
  assert.equal(r.sent[0].posts.length,20);assert.equal(r.sent[0].sessionId,'session');
  r.document.hidden=false;await r.tick();assert.equal(r.sent[1].posts.length,1);
});
test('typing prevents foreground scrolling while collection remains active',async()=>{
  const r=renderer({typing:true});await r.start(null,true);assert.equal(r.scrolls.length,0);
  r.setArticles([{id:'123'}]);await r.tick();assert.equal(r.sent.filter(m=>m.type==='capture').length,1);
  r.document.hidden=true;await r.tick();assert.equal(r.scrolls.length,1);
});
test('content deadline and manual Stop block timer and alarm captures',async()=>{
  for(const manual of [false,true]){
    const r=renderer();await r.start(r.time.time+60000);
    if(manual)r.hooks.ui.onPause();else r.time.time+=60000;
    r.setArticles([{id:'123'}]);await r.tick();r.message({type:'scanner-tick',sessionId:'session'});await settle();
    assert.equal(r.sent.filter(m=>m.type==='capture').length,0);
    assert.equal(r.sent.find(m=>m.type==='stop-session').reason,manual?'stopped':'time-limit');
  }
});
test('transient worker errors retry without silently ending the session',async()=>{
  const r=renderer();r.setArticles([{id:'123'}]);r.fail();await r.start();r.recover();await r.tick();
  assert.equal(r.sent.filter(m=>m.type==='capture').length,2);
  assert.equal(r.sent.filter(m=>m.type==='stop-session').length,0);
});
test('page reload tears down renderer without ending persisted scanner session',async()=>{
  const r=renderer();await r.start();r.hooks.pagehide();r.setArticles([{id:'123'}]);await r.tick();
  assert.equal(r.sent.length,0);
});
