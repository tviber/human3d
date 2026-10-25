import {useState} from 'react';
import {Switch} from '../components/ui/switch';
import type {SkinId} from './skin-swap';
import './skin-switch.css';

/** Both viewers share the same loading, retry and success feedback. */
export function SkinSwitch({change,disabled}:{change:(skin:SkinId)=>Promise<void>;disabled:boolean}){
 const [enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const toggle=async(value:boolean)=>{
  setBusy(true);setError('');
  try{await change(value?'ssj':'default');setEnabled(value);}
  catch(err){setError(err instanceof Error?err.message:String(err));}
  finally{setBusy(false);}
 };
 return <div>
  <label className="skin-switch"><span>超赛皮肤<small>{busy?'正在加载贴图…':'悟空 · 蓝短裤 · 金发'}</small></span><Switch aria-label="超赛皮肤" aria-busy={busy} checked={enabled} disabled={disabled||busy} onCheckedChange={toggle}/></label>
  {error?<p className="skin-switch-error" role="alert">{error}</p>:null}
 </div>;
}
