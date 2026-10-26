import {webPlatform} from '../platform/platform';
import {createRoot} from 'react-dom/client';
import {WorkshopApp} from './WorkshopApp';
import {LIBRARY_KEY} from './library';
import {POSE_LIBRARY_KEY} from './pose-library';
import {RESTORE_POINT_KEY} from './library-backup';
import type {RigInfo} from '@human3d/motion-core';
import '../tailwind.css';
import '../style.css';
import './workshop.css';
import '../components/ui/ui.css';
import '../theme/panels.css';
import '../theme/scroll-regions.css';
const host=document.getElementById('root')!;
webPlatform.fetchAsset('/models/rig.json')
 .then(r=>{if(!r.ok)throw new Error('人体骨架加载失败');return r.json() as Promise<RigInfo>;})
 .then(async info=>{
  await webPlatform.draftOwner?.ready.catch(()=>{});
  let initialLibrary:string|null|undefined,initialPoses:string|null|undefined,initialRestorePoint:string|null=null,storageError='';
  try{[initialLibrary,initialPoses]=await webPlatform.readStorages([LIBRARY_KEY,POSE_LIBRARY_KEY]);}catch(err){storageError=err instanceof Error?err.message:String(err);}
  // Optional: a missing or unreadable restore point only hides the undo offer.
  try{initialRestorePoint=await webPlatform.readStorage(RESTORE_POINT_KEY);}catch{/* no undo offer */}
  createRoot(host).render(<WorkshopApp info={info} initialLibrary={initialLibrary} initialPoses={initialPoses} initialRestorePoint={initialRestorePoint} storageError={storageError}/>);
 })
 .catch(e=>{host.innerHTML=`<main class="ws-loading"><strong>无法加载人体骨架</strong><p>${e instanceof Error?e.message:String(e)}</p></main>`;});
