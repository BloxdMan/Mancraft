// Mancraft multiplayer server (Cloudflare Worker + Durable Objects).
// - Google sign-in required (Firebase ID token), names: letters and _ (1-12), max 20 players per lobby
// - Chat (1.5s cooldown), per-account saves (position, inventory, skin)
// - Per-lobby world seed; on join only NEARBY world edits are sent, the rest is sent per chunk column on request ("need")
// - /lobbies?mode=open|peace lists lobbies with players (used by the Play button)
const MAX=20,NEAR=8,SAFE_CH=1,RESET_MS=7*864e5,NAME=/^[A-Za-z_]{1,12}$/,JWK='https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const RANKS=['bt','yt'],CAPES=['beta','discord']; // must match RANKS / CAPES in index.html
async function loadProfile(uid,tok,env){try{
  const r=await fetch('https://firestore.googleapis.com/v1/projects/'+env.FIREBASE_PROJECT_ID+'/databases/(default)/documents/players/'+uid+'/profile/main',{headers:{Authorization:'Bearer '+tok}});
  if(!r.ok)return{rank:'',capes:[]};const f=(await r.json()).fields||{};
  const rank=f.rank&&f.rank.stringValue,capes=((f.capes&&f.capes.arrayValue&&f.capes.arrayValue.values)||[]).map(v=>v.stringValue);
  return{rank:RANKS.includes(rank)?rank:'',capes:capes.filter(c=>CAPES.includes(c))}}catch(e){return{rank:'',capes:[]}}}
const okCape=(c,v)=>typeof v=='string'&&c.capes.includes(v)?v:'';
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'*'};
const b64=b=>b.replace(/-/g,'+').replace(/_/g,'/'),u8=b=>Uint8Array.from(atob(b64(b)),c=>c.charCodeAt(0));
const num=(v,a,b)=>Number.isFinite(v)&&v>=a&&v<=b;
async function verify(tok,env){try{
  const[h,p,sg]=String(tok).split('.'),hd=JSON.parse(atob(b64(h))),pl=JSON.parse(atob(b64(p))),P=env.FIREBASE_PROJECT_ID;
  if(hd.alg!='RS256'||pl.aud!=P||pl.iss!='https://securetoken.google.com/'+P||pl.exp<Date.now()/1e3||!pl.sub)return null;
  const k=(await(await fetch(JWK,{cf:{cacheTtl:3600}})).json()).keys.find(x=>x.kid==hd.kid);if(!k)return null;
  const key=await crypto.subtle.importKey('jwk',k,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  return await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,u8(sg),new TextEncoder().encode(h+'.'+p))?pl.sub:null}catch(e){return null}}
const okSkin=s=>s&&((Number.isInteger(s.p)&&s.p>=0&&s.p<100)||(typeof s.u=='string'&&s.u.startsWith('data:image/png;base64,')&&s.u.length<60000))?(s.u?{u:s.u}:{p:s.p}):null;
const okInv=a=>Array.isArray(a)&&a.length==46?a.map(v=>Array.isArray(v)&&Number.isInteger(v[0])&&v[0]>0&&v[0]<1000&&Number.isInteger(v[1])&&v[1]>0?[v[0],Math.min(v[1],999)]:0):null;
const pub=o=>({id:o.id,name:o.name,skin:o.skin,x:o.x,y:o.y,z:o.z,yaw:o.yaw,pitch:o.pitch,h:o.h,c:o.c,rank:o.rank||'',cape:o.cape||''});
const colKey=k=>{const p=k.split(',');return(Number(p[0])>>4)+','+(Number(p[2])>>4)};

export default{async fetch(req,env){const u=new URL(req.url);
  if(req.method=='OPTIONS'&&(u.pathname=='/lobbies'||u.pathname=='/ws'))return new Response(null,{headers:CORS});
  if(u.pathname=='/lobbies'){const mode=u.searchParams.get('mode')=='peace'?'peace':'open';
    const r=await env.REG.get(env.REG.idFromName('main')).fetch('https://registry/list?mode='+mode);
    return new Response(r.body,{headers:{...CORS,'content-type':'application/json'}})}
  if(u.pathname=='/ws'){
    const lobby=(u.searchParams.get('lobby')||'').slice(0,32);
    if(req.headers.get('Upgrade')!='websocket')return new Response('WebSocket upgrade required',{status:426,headers:CORS});
    if(!lobby)return new Response('Lobby is required',{status:400,headers:CORS});
    const mode=u.searchParams.get('mode')=='peace'?'peace':'open';
    return env.LOBBY.get(env.LOBBY.idFromName(mode+':'+lobby)).fetch(req)}
  return env.ASSETS.fetch(req)}};

// Keeps a list of lobbies that currently have players (in memory; lobbies re-report every 60s).
export class Registry{
  constructor(){this.m=new Map()}
  async fetch(req){const u=new URL(req.url),now=Date.now();
    if(u.pathname=='/report'){const j=await req.json(),k=j.mode+':'+j.name;if(j.count>0)this.m.set(k,{name:j.name,mode:j.mode,count:j.count,t:now});else this.m.delete(k);return new Response('ok')}
    const mode=u.searchParams.get('mode'),L=[];
    for(const[k,v]of this.m){if(now-v.t>150000){this.m.delete(k);continue}if(v.mode==mode)L.push({name:v.name,count:v.count})}
    return Response.json({max:MAX,lobbies:L})}}

export class Lobby{
  constructor(st,env){this.st=st;this.env=env;this.S=new Map();this.P=new Map();this.n=1;this.dirty=false;this.col=new Map();this.info=null;
    this.ready=st.blockConcurrencyWhile(async()=>{
      this.edits=(await st.storage.get('edits'))||{};this.chests=(await st.storage.get('chests'))||{};
      for(const k in this.edits)this.index(k);
      let seed=await st.storage.get('seed');
      if(seed===undefined){seed=Object.keys(this.edits).length?0:(crypto.getRandomValues(new Int32Array(1))[0]||1);await st.storage.put('seed',seed)} // old worlds (edits but no seed) keep the legacy seed 0
      this.seed=seed;this.spawn=(await st.storage.get('spawn'))||null;
      let lr=await st.storage.get('lastReset');if(lr===undefined){lr=Date.now();await st.storage.put('lastReset',lr)} // hidden: never sent to clients
      this.lastReset=lr;
      this.claims=new Map(Object.entries((await st.storage.get('claims'))||{}))});
    setInterval(()=>this.flush(),10000);setInterval(()=>this.report(),60000)}
  safe(x,z){return!!this.spawn&&Math.abs((x>>4)-(this.spawn[0]>>4))<=SAFE_CH&&Math.abs((z>>4)-(this.spawn[1]>>4))<=SAFE_CH}
  // Every 7 days all player edits inside x/z -420..420 (chunks -26..25) are removed, so that area returns to natural terrain
  async maybeReset(){const now=Date.now();if(now-this.lastReset<RESET_MS)return;this.lastReset=now;await this.st.storage.put('lastReset',now);
    for(let cx=-26;cx<=25;cx++)for(let cz=-26;cz<=25;cz++){const k=cx+','+cz,s=this.col.get(k);if(!s)continue;for(const e of s)delete this.edits[e];this.col.delete(k)}
    for(const k of Object.keys(this.chests)){const p=k.split(',');if(!p.length||p.length<3)continue;const cx=Number(p[0])>>4,cz=Number(p[2])>>4;if(cx>=-26&&cx<=25&&cz>=-26&&cz<=25)delete this.chests[k]}
    this.dirty=true;this.all({t:'reset'})}
  saveClaims(){return this.st.storage.put('claims',Object.fromEntries(this.claims))}
  deny(c,m){this.send(c,{t:'deny',m})}
  index(k){const c=colKey(k);let s=this.col.get(c);if(!s)this.col.set(c,s=new Set());s.add(k)}
  entriesFor(cols){const out=[];for(const[cx,cz]of cols){if(!Number.isInteger(cx)||!Number.isInteger(cz))continue;const s=this.col.get(cx+','+cz);if(!s)continue;for(const k of s){const v=this.edits[k];out.push([...k.split(',').map(Number),v[0],v[1]])}}return out}
  sendEdits(c,list){for(let i=0;i<list.length;i+=3000)this.send(c,{t:'edits',e:list.slice(i,i+3000)})}
  liveCount(){let n=0;for(const c of this.S.values())if(c.live)n++;return n}
  report(){if(!this.info)return;try{this.env.REG.get(this.env.REG.idFromName('main')).fetch('https://registry/report',{method:'POST',body:JSON.stringify({...this.info,count:this.liveCount()})})}catch(e){}}
  async flush(){await this.maybeReset();if(this.dirty){this.dirty=false;await this.st.storage.put({edits:this.edits,chests:this.chests})}
    for(const c of this.S.values())await this.saveP(c)}
  async saveP(c){if(!c.uid||!c.live)return;await this.st.storage.put('u:'+c.uid,{x:c.x,y:c.y,z:c.z,yaw:c.yaw,pitch:c.pitch,inv:c.inv,skin:c.skin})}
  send(c,o){try{c.ws.send(JSON.stringify(o))}catch(e){}}
  all(o,except){for(const c of this.S.values())if(c!==except&&c.live)this.send(c,o)}
  async fetch(req){await this.ready;const u=new URL(req.url);this.info={name:(u.searchParams.get('lobby')||'').slice(0,32),mode:u.searchParams.get('mode')=='peace'?'peace':'open'};
    const[a,b]=Object.values(new WebSocketPair());b.accept();
    const c={ws:b,id:this.n++,me:false,live:false,last:0,x:0,y:0,z:0,yaw:0,pitch:0,h:0,c:0};
    b.addEventListener('message',e=>this.msg(c,e.data));
    b.addEventListener('close',()=>this.drop(c));b.addEventListener('error',()=>this.drop(c));
    return new Response(null,{status:101,webSocket:a})}
  async drop(c){if(this.P.delete(c.id))return;if(!this.S.delete(c.id))return;if(c.live){await this.saveP(c);this.all({t:'leave',id:c.id});this.all({t:'sys',m:c.name+' left the game'});this.report()}}
  async hi(c,m){
    if(c.busy)return;c.busy=true;
    if(!NAME.test(m.name||''))return c.ws.close(4003,'name');
    c.uid=m.tok?await verify(m.tok,this.env):null;if(!c.uid)return c.ws.close(4005,'signin');
    await this.maybeReset();
    if(this.S.size+this.P.size>=MAX)return c.ws.close(4001,'full');
    for(const o of [...this.S.values(),...this.P.values()])if(o.name.toLowerCase()==m.name.toLowerCase())return c.ws.close(4002,'taken');
    c.name=m.name;c.skin=okSkin(m.skin)||{p:0};
    {const pr=await loadProfile(c.uid,m.tok,this.env);c.rank=pr.rank;c.capes=pr.capes;c.cape=okCape(c,m.cape)}
    c.me=true;this.P.set(c.id,c);
    const s=await this.st.storage.get('u:'+c.uid);let me=null;
    if(s){me=s;c.skin=s.skin||c.skin;c.inv=s.inv;Object.assign(c,{x:s.x,y:s.y,z:s.z,yaw:s.yaw,pitch:s.pitch})}
    const ncx=Math.floor((me&&Number.isFinite(me.x)?me.x:0)/16),ncz=Math.floor((me&&Number.isFinite(me.z)?me.z:0)/16);
    this.send(c,{t:'init',id:c.id,seed:this.seed,spawn:this.spawn,claims:[...this.claims.entries()].map(([k,v])=>({c:k,...v})),near:{cx:ncx,cz:ncz,r:NEAR},players:[...this.S.values()].filter(o=>o.live).map(pub),chests:this.chests,me:me&&{x:me.x,y:me.y,z:me.z,yaw:me.yaw,pitch:me.pitch,inv:me.inv,skin:me.skin}});
    const cols=[];for(let a=-NEAR;a<=NEAR;a++)for(let b=-NEAR;b<=NEAR;b++)cols.push([ncx+a,ncz+b]);
    this.sendEdits(c,this.entriesFor(cols));
    this.send(c,{t:'ready'})}
  async msg(c,raw){let m;try{m=JSON.parse(raw)}catch(e){return}if(typeof m!='object'||!m)return;
    if(m.t=='hi'){if(!c.me)await this.hi(c,m);return}if(!c.me)return;
    if(m.t=='go'){if(!c.live&&this.P.delete(c.id)){this.S.set(c.id,c);c.live=true;this.all({t:'join',p:pub(c)},c);this.all({t:'sys',m:c.name+' joined the game'},c);this.report()}return}
    if(m.t=='inv'){const a=okInv(m.a);if(a)c.inv=a;return}
    if(m.t=='spawn'){if(!this.spawn&&Number.isFinite(m.x)&&Number.isFinite(m.z)&&Math.abs(m.x)<1e5&&Math.abs(m.z)<1e5){this.spawn=[Math.floor(m.x),Math.floor(m.z)];await this.st.storage.put('spawn',this.spawn)}return}
    if(m.t=='rt'){this.send(c,{t:'rt',ms:Math.max(0,RESET_MS-(Date.now()-this.lastReset))});return}
    if(m.t=='need'){if(Array.isArray(m.c))this.sendEdits(c,this.entriesFor(m.c.slice(0,64).filter(Array.isArray)));return}
    if(!c.live)return;
    switch(m.t){
    case'p':if(![m.x,m.y,m.z,m.yaw,m.pitch].every(Number.isFinite)||!num(m.y,-100,400))return;
      Object.assign(c,{x:m.x,y:m.y,z:m.z,yaw:m.yaw,pitch:m.pitch,h:m.h|0,c:m.c?1:0});this.all({t:'p',id:c.id,x:m.x,y:m.y,z:m.z,yaw:m.yaw,pitch:m.pitch,h:m.h|0,c:m.c?1:0,sw:m.sw?1:0},c);break;
    case'b':if(!Number.isInteger(m.x)||!Number.isInteger(m.z)||!Number.isInteger(m.y)||!num(m.y,0,191)||!num(m.x,-1e6,1e6)||!num(m.z,-1e6,1e6)||!Number.isInteger(m.b)||!num(m.b,0,255))return;
      if(this.safe(m.x,m.z))return;
      {const ax=m.x>>4,az=m.z>>4,col=ax+','+az,cl=this.claims.get(col);
       if(cl&&cl.o!==c.uid){this.deny(c,'This chunk is claimed by '+cl.n+'.');return}
       const same=cl&&cl.x==m.x&&cl.y==m.y&&cl.z==m.z;
       if(m.b==126&&!same){
        if(ax>=-26&&ax<=25&&az>=-26&&az<=25){this.deny(c,'Claimstones only work outside the spawn area (x/z beyond \u00b1420).');return}
        if(cl){this.deny(c,'This chunk is already claimed.');return}
        let n=0;for(const v of this.claims.values())if(v.o===c.uid)n++;if(n>=8){this.deny(c,'You already have 8 claimstones placed.');return}
        this.claims.set(col,{o:c.uid,n:c.name,x:m.x,y:m.y,z:m.z});await this.saveClaims();this.all({t:'claim',c:col,o:c.uid,n:c.name,x:m.x,y:m.y,z:m.z})}
       else if(same&&m.b!=126){this.claims.delete(col);await this.saveClaims();this.all({t:'unclaim',c:col})}}
      {const d=Number.isInteger(m.d)&&m.b?m.d:undefined,k=m.x+','+m.y+','+m.z;this.edits[k]=d===undefined?[m.b]:[m.b,d];this.index(k);this.dirty=true;this.all({t:'b',x:m.x,y:m.y,z:m.z,b:m.b,d},c)}break;
    case'sk':{const s=okSkin(m.skin);if(!s)return;c.skin=s;c.cape=okCape(c,m.cape);this.all({t:'sk',id:c.id,skin:s,cape:c.cape},c);break}
    case'ch':if(typeof m.k!='string'||m.k.length>40||!Array.isArray(m.a)||m.a.length!=36)return;{const p=m.k.split(',').map(Number);if(p.length>=3){if(this.safe(p[0],p[2]))return;const cl=this.claims.get((p[0]>>4)+','+(p[2]>>4));if(cl&&cl.o!==c.uid){this.deny(c,'This chunk is claimed by '+cl.n+'.');return}}}this.chests[m.k]=m.a;this.dirty=true;this.all({t:'ch',k:m.k,a:m.a},c);break;
    case'tpr':{const t=this.S.get(m.to),n=Date.now();if(!t||!t.live||t===c||n-(c.lastTpr||0)<5000)return;c.lastTpr=n;this.send(t,{t:'tpr',from:c.id,name:c.name});break}
    case'tpa':{const t=this.S.get(m.to);if(t&&t.live&&t!==c)this.send(t,{t:'tpa',from:c.id,name:c.name,ok:!!m.ok});break}
    case'c':{const t=String(m.m||'').replace(/[\u0000-\u001f]/g,'').trim().slice(0,120),n=Date.now();if(!t||n-c.last<1500)return;c.last=n;this.all({t:'c',id:c.id,name:c.name,m:t,rank:c.rank||''});break}
    }}}
