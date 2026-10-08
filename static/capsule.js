/* Standalone SVG dossier: no remote assets, scripts, credentials or hidden payload. */
(() => {
  const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  const cut = (value, max) => {const chars=Array.from(clean(value));return chars.length>max?chars.slice(0,max-1).join('')+'…':chars.join('');};
  const xml = value => clean(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const shortURL = value => {try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?cut(u.hostname+u.pathname,85):'Source unavailable';}catch{return 'Source unavailable';}};
  const count = n => Number.isFinite(n)&&n>=0?String(Math.floor(n)):'-';
  function svg(project, theme='aurora', now=new Date()) {
    const light=theme==='daylight', bg=light?'#f5f0ff':'#12121e',panel=light?'#ffffff':'#202034',fg=light?'#26213c':'#f6f2ff',muted=light?'#625b76':'#b8b0cc';
    const colors=light?['#ad2864','#946000','#28784d','#326cb0']:['#ff93c4','#ffd18b','#99e9be','#a4cfff'];
    const text=(x,y,value,size=20,color=fg,weight=400)=>`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}">${xml(value)}</text>`;
    const demo=project.source==='demo'||project.evidence?.synthetic;
    const status=demo?'DEMO · FICTIONAL EXAMPLE':({shortlisted:'SHORTLIST · FOR RESEARCH',held:'HOLD · NEEDS DATA',rejected:'REJECTED'}[project.status]||'STATUS UNKNOWN');
    const votes=Array.isArray(project.votes)?project.votes.slice(0,4):[];
    const pages=Array.isArray(project.evidence?.pages)?project.evidence.pages:[];
    const sources=[...new Set([project.url,...pages.map(p=>p.url)].filter(Boolean).map(shortURL))];
    const passed=votes.filter(v=>v.vote==='pass').length;
    let out=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="960" viewBox="0 0 1200 960" role="img" aria-label="Gem Search: research capsule"><defs><linearGradient id="rainbow"><stop stop-color="#ff93c4"/><stop offset=".3" stop-color="#ffd18b"/><stop offset=".6" stop-color="#99e9be"/><stop offset="1" stop-color="#b7a3ff"/></linearGradient></defs><rect width="1200" height="960" rx="32" fill="${bg}"/><rect x="40" y="32" width="1120" height="5" rx="2" fill="url(#rainbow)"/><g font-family="Arial,Helvetica,sans-serif">`;
    out+=text(48,85,'GEM SEARCH / DISCOVERY CAPSULE',19,muted,700)+text(48,133,status,18,colors[0],700);
    const name=Array.from(clean(project.name||'Untitled'));
    out+=text(48,194,cut(name.slice(0,37).join(''),37),44,fg,700);
    if(name.length>37)out+=text(48,243,cut(name.slice(37).join(''),37),38,fg,700);
    // Small original spider emblem, drawn entirely inside the SVG.
    out+='<g transform="translate(1080 173)" fill="none" stroke="url(#rainbow)" stroke-width="7" stroke-linecap="round">';
    for(let i=0;i<4;i++){const y=-30+i*20;out+=`<path d="M-15 ${y/2} L-45 ${y} L-65 ${y-17}"/><path d="M15 ${y/2} L45 ${y} L65 ${y-17}"/>`;}
    out+=`<ellipse rx="27" ry="33" fill="${panel}"/><circle cx="-9" cy="-9" r="3" stroke="${fg}"/><circle cx="9" cy="-9" r="3" stroke="${fg}"/></g>`;
    const metrics=[['MENTIONS',count(project.signals?.mentions)],['AUTHORS',count(project.signals?.authors)],['LOCAL CHECKS',`${passed} / ${votes.length}`]];
    metrics.forEach(([label,value],i)=>{const x=48+i*372;out+=`<rect x="${x}" y="280" width="360" height="120" rx="18" fill="${panel}"/>`+text(x+22,316,label,14,muted,700)+text(x+22,369,value,38,colors[i],700);});
    out+=text(48,444,'WHAT THE LOCAL CHECKS SAY',16,muted,700);
    votes.forEach((vote,i)=>{const x=48+(i%2)*558,y=468+Math.floor(i/2)*90;out+=`<rect x="${x}" y="${y}" width="540" height="78" rx="12" fill="${panel}"/>`+text(x+16,y+28,cut(`${vote.seat}: ${vote.vote}`,44),18,colors[i],700)+text(x+16,y+56,cut(vote.reason,48),16,muted);});
    out+=text(48,679,`Grok: ${project.grok?cut(project.grok.status||'no status',30):'no review'} · Source: ${cut(project.source||'unknown',25)}`,17,muted);
    out+=text(48,719,'SOURCES · UP TO 3 LINKS · NO URL PARAMETERS',14,muted,700);
    sources.slice(0,3).forEach((url,i)=>{out+=text(48,751+i*27,cut(url,85),17,fg);});
    if(!sources.length)out+=text(48,751,'No sources attached',17,muted);
    out+=`<path d="M48 849H1152" stroke="${muted}" stroke-opacity=".3"/>`+text(48,881,'A research snapshot. Not a confirmation of safety or future returns.',17,muted)+text(48,918,`Created: ${now.toISOString().slice(0,19).replace('T',' ')} UTC · gem-search`,14,muted);
    return out+'</g></svg>';
  }
  globalThis.GemCapsule={svg};
})();
