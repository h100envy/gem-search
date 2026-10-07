const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let snapshot = {projects:[], launches:[], state:{}}, selected = null, filter = 'all', view = 'discovery', token = '', lastRender = '';
$('#source-filter').insertAdjacentHTML('beforeend','<option value="hn">Hacker News · free</option>');
$('#source-filter').insertAdjacentHTML('beforeend','<option value="spider">Spider · visible X feed</option>');
const labels = {shortlisted:'SHORTLIST',held:'NEEDS DATA',rejected:'REJECTED'};
const kinds = {ticker:'TICKER',contract:'CONTRACT',phrase:'NEW NARRATIVE'};
function ago(seconds){if(!seconds)return '';const m=Math.max(0,Math.round((Date.now()/1000-seconds)/60));return m<1?"just now":m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} d ago`;}
function growthText(s){return s.growth!=null?`×${s.growth} ${s.growth_window||'vs previous hour'}`:'no growth baseline';}
const sorters = {score:null,growth:(a,b)=>(b.signals.growth||0)-(a.signals.growth||0)||b.signals.recent-a.signals.recent,fresh:(a,b)=>(b.signals.first_seen||0)-(a.signals.first_seen||0),authors:(a,b)=>b.signals.authors-a.signals.authors};
function lookup(p){if(p.kind==='ticker')return `<a class="evidence" href="https://x.com/search?q=${encodeURIComponent('$'+p.key)}&amp;f=live" target="_blank" rel="noopener noreferrer">Live X search for $${esc(p.key)} ↗<span>Opens in your browser; Gem Search makes no request</span></a>`;if(p.kind==='contract')return `<a class="evidence" href="https://solscan.io/token/${encodeURIComponent(p.key)}" target="_blank" rel="noopener noreferrer">Address on Solscan ↗<span>${esc(p.key)}</span></a>`;return '';}
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = !message; }
async function api(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-Gem-Token':token},body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function setView(next) {
  view = next;
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== 'view-' + next);
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.view === next));
  $('#view-title').textContent = {discovery:'Discovery',launches:'Launch studio',activity:'Activity log',settings:'Connections'}[next];
  $('#page-title').innerHTML = {discovery:'Find the next <em>signal.</em>',launches:'From narrative to <em>launch.</em>',activity:'Every decision. <em>Recorded.</em>',settings:'Connect your <em>sources.</em>'}[next];
}
function render() {
  const {projects, state, runs, events} = snapshot;
  const auto=snapshot.automation;
  if(auto){
    $('#automation-panel').innerHTML=`<div><span class="eyebrow">ECONOMY AUTOLAUNCH</span><h3>${auto.mode==='live'?'LIVE':'DRY RUN'} · ${esc(auto.provider?.label||'Solana / Pump.fun')}</h3><p>${auto.missing.length?'Live needs: '+esc(auto.missing.join(', ')):'Connections configured'}${auto.error?' · '+esc(auto.error):''}</p><p>${auto.provider?.kind==='bridge'?'External bridge: its operator controls spending and signing. Results are reported by the provider.':'Built-in executor: dedicated wallet and local transaction checks.'}</p></div><div class="auto-budget"><b>${auto.used} <small>/ 5</small></b><span>attempts per 24h</span></div><div class="auto-budget"><b>0.025 <small>SOL</small></b><span>cap per launch</span></div><div class="auto-budget"><b>${auto.reserved_sol.toFixed(3)} <small>/ 0.125</small></b><span>SOL reserved · ${auto.mode}</span></div><button id="pause-launches" class="secondary">${auto.enabled?'Ⅱ Pause queue':'▶ Resume'}</button>`;
    $('#auto-jobs').innerHTML=auto.jobs.length?auto.jobs.map(j=>`<div class="launch-item"><span class="badge ${j.status==='confirmed'?'':'held'}">${esc(j.mode)} / ${esc(j.status)} · ${esc(j.provider?.label||'Pump.fun')}</span><h3>${esc(j.name)} <span class="muted">$${esc(j.symbol)}</span></h3><p>${esc(j.narrative)}</p><p>${esc(j.reason||'Waiting for a free slot')}</p>${Number.isFinite(j.actual_lamports)?`<p>Spent: ${(j.actual_lamports/1e9).toFixed(6)} SOL · Left in the dedicated wallet: ${((j.residual_lamports||0)/1e9).toFixed(6)} SOL</p>`:''}${j.signature?`<a href="https://solscan.io/tx/${encodeURIComponent(j.signature)}" target="_blank" rel="noopener noreferrer">Transaction ↗</a>`:''}${j.mint?`<p class="project-meta">Mint: ${esc(j.mint)}</p>`:''}</div>`).join(''):'<div class="empty">The queue fills automatically from the fresh shortlist.<br>Demo projects never enter it. Five is a ceiling, not a quota.</div>';
  }
  $('#pipeline-status').textContent = state.running ? state.stage : state.autopilot ? 'Economy scanner active' : 'Scanner ready';
  $('#pipeline-detail').textContent = state.last_poll ? 'Last poll: ' + new Date(state.last_poll).toLocaleTimeString('en-US') : 'Demo and import available';
  $('#demo').disabled = state.running;
  $('#import-button').disabled = state.running;
  $('#autopilot').classList.toggle('on', state.autopilot);
  $('#autopilot').innerHTML = `Autopilot: ${state.autopilot ? 'ON' : 'OFF'} <span class="switch"></span>`;
  if (state.error) notice(state.error);
  const source = $('#source-filter').value;
  const kind = $('#kind-filter').value, order = sorters[$('#sort').value];
  const subset = projects.filter(p => (source === 'all' || p.source === source) && (kind === 'all' || (p.kind || 'topic') === kind));
  const latest = runs.find(r => source === 'all' || r.source === source);
  $('#stats').innerHTML = [["Posts in last scan",latest?.posts || 0,latest ? `${latest.source.toUpperCase()} · ${new Date(latest.created).toLocaleTimeString('en-US')}` : 'Run your first scan'],['Candidates',subset.length,'Unique project pages'],['Needs data',subset.filter(p=>p.status==='held').length,'Evidence has gaps'],['Shortlisted',subset.filter(p=>p.status==='shortlisted').length,'Passed 4 of 4 checks']].map(([label,value,foot])=>`<div class="stat"><div class="stat-label">${esc(label)} <span>↗</span></div><div class="stat-value">${value}</div><div class="stat-foot">${esc(foot)}</div></div>`).join('');
  const visible = subset.filter(p => filter === 'all' || p.status === filter);
  if (order) visible.sort(order);
  $('#candidate-count').textContent = visible.length;
  if (!visible.some(p=>p.id===selected)) selected = visible[0]?.id;
  $('#projects').innerHTML = visible.length ? visible.map(p=>`<button class="project ${selected===p.id?'selected':''}" data-id="${p.id}"><span class="project-icon">${esc(p.name.slice(0,1))}</span><span class="project-body"><span class="project-name">${esc(p.name)} ${p.source==='demo'?'<span class="badge demo">DEMO</span>':''}${kinds[p.kind]?`<span class="badge kind">${kinds[p.kind]}</span>`:''}</span><span class="project-meta">${p.signals.mentions} mentions · ${p.signals.authors} authors · ${esc(growthText(p.signals))}${p.signals.first_seen?' · first seen '+ago(p.signals.first_seen):''}</span></span><span class="project-side"><span class="score">${p.score/25}<small> / 4</small></span><br><span class="badge ${p.status}">${labels[p.status]}</span></span></button>`).join('') : '<div class="empty"><div class="glyph">◈</div>Found projects will appear here.<br>Run the demo or import JSON with mentions.</div>';
  const p = projects.find(p=>p.id===selected);
  $('#detail').innerHTML = p ? `<div class="detail-top"><span class="eyebrow">SIGNAL DOSSIER</span><span class="badge ${p.status}">${labels[p.status]}</span></div><h2>${esc(p.name)}</h2><a class="detail-link" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)} ↗</a>${p.source==='demo'?'<p class="project-meta">Fictional example. Evidence is synthetic.</p>':''}${p.signals.first_seen?`<div class="subheading">SIGNAL VELOCITY</div><div class="velocity"><div><b>${p.signals.recent}</b><span>last 6h</span></div><div><b>${p.signals.previous}</b><span>prev 18h</span></div><div><b>${p.signals.growth!=null?'×'+p.signals.growth:'-'}</b><span>pace</span></div><div><b>${p.signals.recent_authors}</b><span>authors 6h</span></div></div><p class="project-meta">The spider first saw this ${esc(ago(p.signals.first_seen))}; the earliest post appeared ${esc(ago(p.signals.first_posted))}. This is a sample of your tabs, not all of X.</p>`:''}${p.research_only?'<p class="project-meta">Research only: tickers, contracts and other people’s phrases never enter the launch queue.</p>':''}${lookup(p)}<div class="subheading">FOUR-SEAT REVIEW · RULE ENGINE</div><div class="votes">${p.votes.map((v,i)=>`<div class="vote"><span class="seat-icon">${['◉','⌘','◇','↗'][i]}</span><div><div class="vote-name">${v.seat}</div><p>${esc(v.reason)}</p></div><span class="vote-result ${v.vote}">${v.vote}</span></div>`).join('')}</div><div class="subheading">COLLECTED EVIDENCE</div>${p.evidence.pages.map(e=>`<a class="evidence" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.kind)} ↗<span>${esc(e.url)}</span></a>`).join('') || '<p class="project-meta">No pages fetched</p>'}${p.evidence.errors.map(e=>`<p class="project-meta">${esc(e.error)}</p>`).join('')}<button class="secondary capsule-open" id="capsule-open">✦ Discovery capsule · download card</button><button class="primary" id="concept">Prepare a token concept ↗</button>` : '<div class="empty"><div class="glyph">⌕</div>Pick a project<br>to study its evidence.</div>';
  $('#events').innerHTML = events.length ? events.map(e=>`<div class="event"><time>${esc(new Date(e.created).toLocaleString('en-US'))}</time><span>${esc(e.message)}</span></div>`).join('') : '<div class="empty">No events yet.</div>';
  const connections = snapshot.connections || {};
  $('#connections').innerHTML = [['JSON / inbox','Connected'],['X API',connections.x?'Key configured':'X_BEARER_TOKEN required'],['Crawler','Public HTTP(S) pages · up to 3 pages'],['DOTS','Four rule-based checks'],['Token launch',connections.launch || 'Waiting for network and wallet']].map(([name,status])=>`<div class="connection"><b>${name}</b><span>${esc(status)}</span></div>`).join('') + (connections.x ? '<button id="scan-x" class="primary">Scan X</button>' : '');
  $('#connections').insertAdjacentHTML('afterbegin',`<div class="spider-connect"><div class="eyebrow">THE NARRATIVE SPIDER</div><h3>Connect the extension to this computer</h3><p>Load the <code>extension/</code> folder via chrome://extensions → Developer mode → Load unpacked. Paste the code into the extension popup, open X and click Release spider.</p><button id="copy-pairing" class="primary">Copy pairing code</button><p>Captured: ${snapshot.spider?.captured||0} · Queued: ${snapshot.spider?.pending||0}</p><p>Grok: ${snapshot.grok?.enabled?(snapshot.grok.configured?'connected':'XAI_API_KEY required'):'off'} · ${esc(snapshot.grok?.model||'')} · calls ${snapshot.grok?.calls_used||0}/${snapshot.grok?.calls_limit||12} per 24h.</p></div>`);
  if(p?.grok){$('#detail').insertAdjacentHTML('beforeend',`<div class="subheading">GROK SEATS · ${esc(p.grok.model)} · ${esc(p.grok.status)}</div><div class="votes">${p.grok.votes.map(v=>`<div class="vote"><span class="seat-icon">✦</span><div><div class="vote-name">${esc(v.seat)}</div><p>${esc(v.reason)}</p><p>${esc((v.evidence_ids||[]).join(', '))}</p></div><span class="vote-result ${v.vote}">${esc(v.vote)}</span></div>`).join('')}</div>`);}
  $('#launch-connection').textContent = connections.launch || 'Drafts available. Real launches are not connected.';
  $('#launches').innerHTML = snapshot.launches?.length ? snapshot.launches.map(l=>`<div class="launch-item"><span class="badge held">${esc(l.status)}</span><h3>${esc(l.name)} <span class="muted">$${esc(l.symbol)}</span></h3><p>${esc(l.description)}</p><p class="project-meta">${esc(l.narrative)} · Dev buy: ${esc(l.amount)} SOL</p><div class="actions"><button class="secondary download-metadata" data-id="${esc(l.id)}">Metadata ↓</button><button class="secondary simulate" data-id="${esc(l.id)}">Check draft</button></div>${l.result?`<p>${esc(l.result)}</p>`:''}</div>`).join('') : '<div class="empty"><div class="glyph">↗</div>Create your first draft.<br>It is saved locally and sends no transaction.</div>';
}
async function refresh(force=false) {
  try { const data=await api('state'); token=data.token; snapshot=data; const next=JSON.stringify(data); if(force||next!==lastRender){lastRender=next;render();} } catch(e){notice('Server unavailable: '+e.message);}
}
function download(name,data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
document.querySelectorAll('.nav').forEach(el=>el.onclick=()=>setView(el.dataset.view));
document.querySelectorAll('.filter').forEach(el=>el.onclick=()=>{filter=el.dataset.filter;document.querySelectorAll('.filter').forEach(b=>b.classList.toggle('active',b===el));render();});
$('#source-filter').onchange=render;
$('#kind-filter').onchange=render;
$('#sort').onchange=render;
$('#automation-panel').onclick=async e=>{if(e.target.id==='pause-launches'){try{await api('launch-control',{enabled:!snapshot.automation.enabled});await refresh(true);}catch(error){notice(error.message);}}};
$('#connections').onclick=async e=>{if(e.target.id==='copy-pairing'){try{await navigator.clipboard.writeText(snapshot.pairing_code);notice('Code copied. Paste it into the Gem Search popup.');}catch{notice('Copying unavailable. Code: '+snapshot.pairing_code);}}if(e.target.id==='scan-x'){try{await api('x',{});notice('X: requested the latest 100 posts for the configured query.');await refresh(true);}catch(error){notice(error.message);}}};
$('#projects').onclick=e=>{const el=e.target.closest('[data-id]');if(el){selected=el.dataset.id;render();}};
$('#detail').onclick=e=>{if(e.target.id==='capsule-open'){openCapsule();return;}if(e.target.id==='concept'){const p=snapshot.projects.find(p=>p.id===selected);setView('launches');const f=$('#launch-form');f.elements.name.value='';f.elements.symbol.value='';f.elements.narrative.value=(p.source==='demo'?'DEMO: ':'')+p.name+' - '+p.url;f.elements.description.value='Independent community token inspired by a research narrative. Not affiliated with or endorsed by the referenced project.';f.elements.name.focus();}};
$('#demo').onclick=async()=>{try{notice('');await api('demo',{});await refresh(true);}catch(e){notice(e.message);}};
$('#autopilot').onclick=async()=>{try{await api('autopilot',{enabled:!snapshot.state.autopilot});await refresh(true);}catch(e){notice(e.message);}};
$('#import-button').onclick=()=>$('#import-file').click();
$('#import-file').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>2_000_000)throw new Error('File exceeds 2 MB');await api('import',JSON.parse(await file.text()));notice('Import accepted. Checks run in the background.');await refresh(true);}catch(error){notice(error.message);}finally{e.target.value='';}};
$('#export').onclick=()=>download('gem-search-report.json',{exported_at:new Date().toISOString(),projects:snapshot.projects});
$('#launch-form').onsubmit=async e=>{e.preventDefault();try{const body=Object.fromEntries(new FormData(e.target));body.amount=Number(body.amount);body.priority_fee=Number(body.priority_fee);await api('launches',body);e.target.reset();notice('Draft saved.');await refresh(true);}catch(error){notice(error.message);}};
$('#launches').onclick=async e=>{const button=e.target.closest('button');if(!button)return;const l=snapshot.launches.find(l=>l.id===button.dataset.id);if(button.classList.contains('download-metadata'))download(l.symbol+'-metadata.json',{name:l.name,symbol:l.symbol,description:l.description});if(button.classList.contains('simulate')){try{await api('launches/check',{id:l.id});await refresh(true);}catch(error){notice(error.message);}}};
refresh(true);setInterval(()=>refresh(),2000);

let capsuleProject=null, capsuleURL=null;
function drawCapsule(){
  if(capsuleURL)URL.revokeObjectURL(capsuleURL);
  capsuleURL=URL.createObjectURL(new Blob([GemCapsule.svg(capsuleProject,$('#capsule-theme').value,capsuleDate)],{type:'image/svg+xml;charset=utf-8'}));
  $('#capsule-preview').src=capsuleURL;
}
let capsuleDate;
function openCapsule(){
  const project=snapshot.projects.find(p=>p.id===selected);if(!project)return;
  capsuleProject=structuredClone(project);capsuleDate=new Date();drawCapsule();$('#capsule-dialog').showModal();
}
$('#capsule-theme').onchange=drawCapsule;
$('#capsule-close').onclick=()=>$('#capsule-dialog').close();
$('#capsule-dialog').addEventListener('close',()=>{if(capsuleURL)URL.revokeObjectURL(capsuleURL);capsuleURL=null;capsuleProject=null;$('#capsule-preview').removeAttribute('src');});
$('#capsule-save').onclick=()=>{if(!capsuleURL)return;const a=document.createElement('a');a.href=capsuleURL;a.download='gem-search-capsule-'+capsuleDate.toISOString().slice(0,10)+'.svg';a.click();};
