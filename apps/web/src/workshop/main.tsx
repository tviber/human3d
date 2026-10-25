import {webPlatform} from '../platform/platform';
import {createRoot} from 'react-dom/client';
import {WorkshopApp} from './WorkshopApp';
import type {RigInfo} from '@human3d/motion-core';
import '../tailwind.css';
import '../style.css';
import './workshop.css';
import '../components/ui/ui.css';
import '../theme/panels.css';
const host=document.getElementById('root')!;
webPlatform.fetchAsset('/models/rig.json')
 .then(r=>{if(!r.ok)throw new Error('人体骨架加载失败');return r.json() as Promise<RigInfo>;})
 .then(async info=>{await webPlatform.draftOwner?.ready.catch(()=>{});createRoot(host).render(<WorkshopApp info={info}/>);})
 .catch(e=>{host.innerHTML=`<main class="ws-loading"><strong>无法加载人体骨架</strong><p>${e instanceof Error?e.message:String(e)}</p></main>`;});
