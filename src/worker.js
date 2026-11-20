// Mancraft multiplayer server (Cloudflare Worker + Durable Object).
// Protocol matches index.html. Adds: chat (1.5s cooldown), unique 1-12 letter names,
// and per-account saves (position, inventory, skin) for players signed in with Google.
const MAX=8,NAME=/^[A-Za-z]{1,12}$/,JWK='https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const u8=b=>Uint8Array.from(atob(b.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const num=(v,a,b)=>Number.isFinite(v)&&v>=a&&v<=b;
async function verify(tok,env){try{
  const[h,p,sg]=String(tok).split('.'),hd=JSON.parse(atob(h.replace(/-/g,'+').replace(/_/g,'/'))),pl=JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/'))),P=env.FIREBASE_PROJECT_ID;
  if(hd.alg!='RS256'||pl.aud!=P||pl.iss!='https://securetoken.google.com/'+P||pl.exp<Date.now()/1e3||!pl.sub)return null;
  const ks=(await(await fetch(JWK,{cf:{cacheTtl:3600}})).json()).keys,k=ks.find(x=>x.kid==hd.kid);if(!k)return null;
  const key=await crypto.subtle.importKey('jwk',k,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  return await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,u8(sg),new TextEncoder().encode(h+'.'+p))?pl.sub:null}catch(e){return null}}
const okSkin=s=>s&&((Number.isInteger(s.p)&&s.p>=0&&s.p<100)||(typeof s.u=='string'&&s.u.startsWith('data:image/png;base64,')&&s.u.length<60000))?(s.u?{u:s.u}:{p:s.p}):null;
const okInv=a=>Array.isArray(a)&&a.length==46?a.map(v=>Array.isArray(v)&&Number.isInteger(v[0])&&v[0]>0&&v[0]<1000&&Number.isInteger(v[1])&&v[1]>0?[v[0],Math.min(v[1],999)]:0):null;

export default{async fetch(req,env){const u=new URL(req.url),lobby=(u.searchParams.get('lobby')||'').slice(0,32);
  if(u.pathname!='/ws'||req.headers.get('Upgrade')!='websocket'||!lobby)return new Response('Mancraft server');
  const mode=u.searchParams.get('mode')=='peace'?'peace':'open';
  return env.LOBBY.get(env.LOBBY.idFromName(mode+':'+lobby)).fetch(req)}};

export class Lobby{
  constructor(st,env){this.st=st;this.env=env;this.S=new Map();this.n=1;this.dirty=false;
    this.ready=st.blockConcurrencyWhile(async()=>{this.edits=(await st.storage.get('edits'))||{};this.chests=(await st.storage.get('chests'))||{}});
    setInterval(()=>this.flush(),10000)}
  async flush(){if(this.dirty){this.dirty=false;await this.st.storage.put({edits:this.edits,chests:this.chests})}
    for(const c of this.S.values())await this.saveP(c)}
  async saveP(c){if(!c.uid||!c.me)return;await this.st.storage.put('u:'+c.uid,{x:c.x,y:c.y,z:c.z,yaw:c.yaw,pitch:c.pitch,inv:c.inv,skin:c.skin})}
  send(c,o){try{c.ws.send(JSON.stringify(o))}catch(e){}}
  all(o,except){for(const c of this.S.values())if(c!==except&&c.me)this.send(c,o)}
  async fetch(req){await this.ready;const[a,b]=Object.values(new WebSocketPair());b.accept();
    const c={ws:b,id:this.n++,me:false,last:0,x:0,y:0,z:0,yaw:0,pitch:0,h:0,c:0};
    b.addEventListener('message',e=>this.msg(c,e.data));
    b.addEventListener('close',()=>this.drop(c));b.addEventListener('error',()=>this.drop(c));
    return new Response(null,{status:101,webSocket:a})}
  async drop(c){if(!this.S.delete(c.id)||!c.me)return;await this.saveP(c);this.all({t:'leave',id:c.id});this.all({t:'sys',m:c.name+' left the game'})}
  async hi(c,m){
    if(this.S.size>=MAX)return c.ws.close(4001,'full');
    if(!NAME.test(m.name||''))return c.ws.close(4003,'name');
    for(const o of this.S.values())if(o.me&&o.name.toLowerCase()==m.name.toLowerCase())return c.ws.close(4002,'taken');
    c.name=m.name;c.skin=okSkin(m.skin)||{p:0};c.uid=m.tok?await verify(m.tok,this.env):null;
    let me=null;if(c.uid){const s=await this.st.storage.get('u:'+c.uid);if(s){me=s;c.skin=s.skin||c.skin;c.inv=s.inv;Object.assign(c,{x:s.x,y:s.y,z:s.z,yaw:s.yaw,pitch:s.pitch})}}
    if(this.S.size>=MAX)return c.ws.close(4001,'full');
    c.me=true;this.S.set(c.id,c);
    const pub=o=>({id:o.id,name:o.name,skin:o.skin,x:o.x,y:o.y,z:o.z,yaw:o.yaw,pitch:o.pitch,h:o.h,c:o.c});
    this.send(c,{t:'init',id:c.id,players:[...this.S.values()].filter(o=>o!==c&&o.me&&o.x!==undefined&&(o.x||o.y||o.z||o.has)).map(pub).concat([...this.S.values()].filter(o=>o!==c&&o.me&&!(o.x||o.y||o.z||o.has)).map(o=>({id:o.id,name:o.name,skin:o.skin}))),chests:this.chests,me:me&&{x:me.x,y:me.y,z:me.z,yaw:me.yaw,pitch:me.pitch,inv:me.inv,skin:me.skin}});
    const e=Object.entries(this.edits).map(([k,v])=>[...k.split(',').map(Number),v[0],v[1]]);
    for(let i=0;i<e.length;i+=4000)this.send(c,{t:'edits',e:e.slice(i,i+4000)});
    this.all({t:'join',p:me?pub(c):{id:c.id,name:c.name,skin:c.skin}},c);this.all({t:'sys',m:c.name+' joined the game'},c)}
  async msg(c,raw){let m;try{m=JSON.parse(raw)}catch(e){return}if(typeof m!='object'||!m)return;
    if(m.t=='hi'){if(!c.me)await this.hi(c,m);return}if(!c.me)return;
    switch(m.t){
    case'p':if(![m.x,m.y,m.z,m.yaw,m.pitch].every(Number.isFinite)||!num(m.y,-100,400))return;
      Object.assign(c,{x:m.x,y:m.y,z:m.z,yaw:m.yaw,pitch:m.pitch,h:m.h|0,c:m.c?1:0,has:1});this.all({t:'p',id:c.id,x:m.x,y:m.y,z:m.z,yaw:m.yaw,pitch:m.pitch,h:m.h|0,c:m.c?1:0,sw:m.sw?1:0},c);break;
    case'b':if(!Number.isInteger(m.x)||!Number.isInteger(m.z)||!Number.isInteger(m.y)||!num(m.y,0,191)||!num(m.x,-1e6,1e6)||!num(m.z,-1e6,1e6)||!Number.isInteger(m.b)||!num(m.b,0,255))return;
      this.edits[m.x+','+m.y+','+m.z]=Number.isInteger(m.d)&&m.b?[m.b,m.d]:[m.b];this.dirty=true;this.all({t:'b',x:m.x,y:m.y,z:m.z,b:m.b,d:Number.isInteger(m.d)&&m.b?m.d:undefined},c);break;
    case'sk':{const s=okSkin(m.skin);if(!s)return;c.skin=s;this.all({t:'sk',id:c.id,skin:s},c);break}
    case'ch':if(typeof m.k!='string'||m.k.length>40||!Array.isArray(m.a)||m.a.length!=36)return;this.chests[m.k]=m.a;this.dirty=true;this.all({t:'ch',k:m.k,a:m.a},c);break;
    case'inv':{const a=okInv(m.a);if(a)c.inv=a;break}
    case'c':{const t=String(m.m||'').replace(/[\u0000-\u001f]/g,'').trim().slice(0,120),n=Date.now();if(!t||n-c.last<1500)return;c.last=n;this.all({t:'c',id:c.id,name:c.name,m:t});break}
    }}}
