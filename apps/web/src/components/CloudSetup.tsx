import { useEffect, useState } from 'react';
import { isSetup, type PortableSetup } from '@hypergate/shared';
const cloud='https://nekko-agent-api.fly.dev';
const local=(import.meta.env.VITE_DAEMON_URL ?? '').replace(/\/$/,'')+'/api/cloud-setup';
type Doc={revision:number;updatedAt:string|null;setup:PortableSetup|null};
async function request(url:string, method='GET', body?:unknown, headers:Record<string,string>={}) {
  const r=await fetch(url,{method,redirect:'error',credentials:'omit',cache:'no-store',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw new Error(r.status===403?'Coming soon for this account.':r.status===409?'Setup changed. Refresh and review the latest revision.':r.status===401?'Sign-in expired or code not accepted.':'Request failed ('+r.status+'). Try again.');
  return r.status===204?null:r.json();
}
export function CloudSetup({master,onApply}:{master?:string;onApply:()=>void}) {
 const [email,E]=useState(''),[code,C]=useState(''),[provider,P]=useState<{origin:string;key:string}|null>(null),[session,S]=useState('');
 const [doc,D]=useState<Doc|null>(null),[here,H]=useState<PortableSetup|null>(null),[busy,B]=useState(false),[message,M]=useState('');
 // Each sign-in belongs to this view. Drop the bearer when the user leaves Settings.
 useEffect(()=>()=>{if(session)void fetch(cloud+'/v1/auth/session',{method:'DELETE',keepalive:true,credentials:'omit',redirect:'error',headers:{Authorization:'Bearer '+session}}).catch(()=>{});},[session]);
 const auth=(t:string)=>({Authorization:'Bearer '+t});
 const run=async(f:()=>Promise<void>)=>{B(true);M('');try{await f();}catch(e){M(e instanceof Error?e.message:'Could not reach Cloud.');}finally{B(false);}};
 const refresh=async(t:string)=>{D(null);H(null);const [d,h]=await Promise.all([request(cloud+'/v1/hypergate/setup','GET',undefined,auth(t)),request(local,'GET',undefined,auth(master!))]);
   if(!Number.isSafeInteger(d.revision)||(d.setup!==null&&!isSetup(d.setup))||!isSetup(h))throw new Error('Unsupported setup. Update Hypergate before syncing.');D(d);H(h);};
 const send=async()=>{const cfg=await request(cloud+'/v1/auth/config'),u=new URL(cfg.supabaseUrl);if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co'))throw new Error('Sign-in provider unavailable.');
   await request(u.origin+'/auth/v1/otp','POST',{email:email.trim(),create_user:false},{apikey:cfg.supabaseAnonKey});P({origin:u.origin,key:cfg.supabaseAnonKey});};
 const verify=async()=>{if(!provider)return;const v=await request(provider.origin+'/auth/v1/verify','POST',{email:email.trim(),token:code.trim(),type:'email'},{apikey:provider.key});
   const s=await request(cloud+'/v1/auth/session','POST',{accessToken:v.access_token,label:'Hypergate preview'});C('');P(null);S(s.token);await refresh(s.token);};
 const btn=(label:string,fn:()=>Promise<void>)=><button type="button" className="btn sm" disabled={busy||!master} onClick={()=>void run(fn)}>{label}</button>;
 return <><div className="section-title">Nekko Cloud</div><div className="panel cloud-setup"><strong>{session&&doc?'Portable setup':'Coming soon · Employee preview'}</strong>
 <p className="small muted">Sync desktop preferences and catalog server selections. Keys, accounts, custom commands and paths stay here. Nothing syncs until you choose it.</p>
 {!session?<>{!provider?<><label>Work email <input type="email" autoComplete="email" value={email} onChange={e=>E(e.target.value)}/></label> {btn('Send sign-in code',send)}</>:<><label>Email code <input autoComplete="one-time-code" value={code} onChange={e=>C(e.target.value)}/></label> {btn('Verify code',verify)} {btn('Change email',async()=>{P(null);C('');})}</>}</>:<>
 {here&&doc&&<><p>{doc.revision?'Cloud revision '+doc.revision:'No setup published yet.'}</p>
 <table><caption>Review portable settings</caption><thead><tr><th>Setting</th><th>This computer</th><th>Cloud</th></tr></thead><tbody>
 {([['Start minimized',here.startMinimized?'Yes':'No',doc.setup?doc.setup.startMinimized?'Yes':'No':'Not saved'],['On close',here.closeAction,doc.setup?.closeAction??'Not saved'],...Array.from(new Set([...here.servers,...(doc.setup?.servers??[])].map(s=>s.catalogId))).map(id=>[id,...[here,doc.setup].map((s,i)=>{const v=s?.servers.find(row=>row.catalogId===id);return v?v.enabled?'Enabled':'Disabled':i===0?'Set up locally first':'Not saved';})])] as string[][]).map(([label,l,c])=><tr key={label}><th>{label}</th><td>{l}</td><td>{c}</td></tr>)}
 </tbody></table><p className="small muted">Publishing replaces the Cloud setup. Applying updates the settings shown for installed servers only. Server changes take effect on the next daemon start.</p>
 {btn('Publish this computer’s setup',async()=>{const now=await request(local,'GET',undefined,auth(master!));if(!isSetup(now))throw new Error('Unsupported setup. Update Hypergate before syncing.');if(JSON.stringify(now)!==JSON.stringify(here)){H(now);throw new Error('This computer’s setup changed. Review it and publish again.');}D(await request(cloud+'/v1/hypergate/setup','PUT',{baseRevision:doc.revision,setup:here},auth(session)));M('Published. Other computers are unchanged.');})} {' '}
 {doc.setup&&btn('Apply reviewed setup locally',async()=>{const latest=await request(cloud+'/v1/hypergate/setup','GET',undefined,auth(session));if(latest.revision!==doc.revision)throw new Error('Cloud setup changed. Refresh before applying.');H(await request(local,'POST',{reviewed:here,desired:doc.setup},auth(master!)));onApply();M('Applied on this computer.');})}</>}
 {' '}{btn('Refresh',()=>refresh(session))} {' '}{btn('Sign out',async()=>{S('');D(null);H(null);E('');})}</>}
 {message&&<p role="status">{message}</p>}</div></>;
}
