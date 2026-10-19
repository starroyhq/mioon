import React, { useEffect, useRef, useState } from 'react';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchAlert, WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { Eye, EyeOff } from '@mioon/ui/components/workbench-icons';
import LanguageControl from './LanguageControl.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import './login-redesign.css';
export default function LoginScreen({ onLogin }: { onLogin: () => Promise<void> }) {
  const { t } = useI18n(), [token,setToken] = useState(''), [revealed,setRevealed] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState<'invalid'|'unavailable'|null>(null);
  const live=useRef(true), flight=useRef<AbortController|null>(null);
  useEffect(()=>{live.current=true;return()=>{live.current=false;flight.current?.abort();};},[]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if(!live.current || flight.current || !token)return;
    const request=new AbortController();flight.current=request;setBusy(true);setError(null);
    try {
      const response=await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),signal:request.signal});
      if(response.status===401){if(live.current)setError('invalid');return;}
      const result:unknown=await response.json();
      if(response.status!==200||!result||typeof result!=='object'||!('ok'in result)||result.ok!==true||Object.keys(result).some(key=>key!=='ok'))throw new Error('Unconfirmed login.');
      if(live.current){setToken('');setRevealed(false);await onLogin();}
    }catch{if(live.current)setError('unavailable');}
    finally{if(flight.current===request)flight.current=null;if(live.current)setBusy(false);}
  }
  return <main className="login-redesign" data-testid="login-page"><section className="login-redesign-card"><div className="login-redesign-language"><LanguageControl /></div><form onSubmit={event=>void submit(event)} aria-labelledby="login-title" aria-busy={busy}>
    <h1 id="login-title">Mioon</h1><p className="login-redesign-tagline">{t('redesign.login.tagline')}</p>
    <Label htmlFor="access-token">{t('shell.login.token')}</Label><div className="login-redesign-token"><Input id="access-token" data-testid="access-token" type={revealed?'text':'password'} autoComplete="current-password" value={token} maxLength={4096} disabled={busy} onChange={event=>{if(!flight.current)setToken(event.target.value);}} placeholder={t('shell.login.placeholder')} required autoFocus /><WorkbenchButton variant="icon" type="button" disabled={busy} aria-label={t(revealed?'redesign.login.hide':'redesign.login.show')} aria-pressed={revealed} onClick={()=>setRevealed(value=>!value)}>{revealed?<EyeOff size={16}/>:<Eye size={16}/>}</WorkbenchButton></div>
    {error&&<WorkbenchAlert tone="danger">{t(error==='invalid'?'shell.login.invalidToken':'shell.error.incomplete')}</WorkbenchAlert>}
    <WorkbenchButton variant="primary" size="large" type="submit" data-testid="login-submit" disabled={busy||!token} loading={busy}>{t('shell.login.enter')}</WorkbenchButton><p className="login-redesign-location">{t('redesign.login.location')} <code>data/access-token</code></p>
  </form></section></main>;
}
