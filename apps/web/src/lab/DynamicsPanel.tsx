import type {DynamicsCase,DynamicsReadout} from './dynamics';
import {muscleName} from './dynamics';
import {ArrowUpRight} from 'lucide-react';
export function DynamicsPanel({data,objectDescription,onCase,onResearch}:{data:DynamicsReadout;objectDescription?:string;onCase:(value:DynamicsCase)=>void;onResearch:()=>void}){
 return <section className="dynamics-panel" aria-label="肌骨力学数据">
  <div className="dynamics-title"><h2>力学观测</h2><button onClick={onResearch}>依据与边界<ArrowUpRight size={14}/></button></div>
  <p className="dynamics-caption">MuJoCo 正向仿真回放 · 降阶肌骨模型</p>
  {objectDescription?<p className="experiment-note">{objectDescription}</p>:null}
  <div className="dynamics-cases" aria-label="肌力对照"><button aria-pressed={data.case==='baseline'} disabled={data.loading} onClick={()=>onCase('baseline')}>基准肌力</button><button aria-pressed={data.case==='weak'} disabled={data.loading} onClick={()=>onCase('weak')}>右臂肌力 90%</button></div>
  {data.case==='weak'?<p className="experiment-note">右臂主动与被动力上限降至 90%，肌肉分配针对同一任务重新求解；这是模型敏感性对照，不是个体能力预测。</p>:null}
  <dl className="physics-readouts"><div><dt>手端速度</dt><dd>{data.speed.toFixed(2)} <small>m/s</small></dd></div><div><dt>支撑反力合计 Fz</dt><dd>{(data.support[2]+data.support[5]).toFixed(0)} <small>N</small></dd></div></dl>
  <div className="physics-subheading">肌肉机械功率 <small>W</small></div>
  <div className="power-list">{['下肢','躯干','上肢'].map((name,i)=><div key={name}><span>{name}</span><div className="power-track"><i className={data.power[i]<0?'absorbing':''} style={{width:`${Math.min(100,Math.abs(data.power[i])/450*100)}%`}}/></div><output>{data.power[i]>0?'+':''}{data.power[i].toFixed(0)}</output></div>)}</div>
  <p className="physics-footnote">正值做功，负值吸收。按模型肌群分组，不能直接当作跨关节能量流。</p>
  <div className="physics-subheading">代表肌肉束 <small>激活 / 拉力</small></div>
  <div className="muscle-list">{data.muscles.map(m=><div key={m.name}><span title={m.name}>{muscleName(m.name)}</span><output>{Math.round(m.activation*100)}% <b>{m.force.toFixed(0)} N</b></output></div>)}</div>
  <p className="physics-footnote">蓝 → 橙红表示低 → 高激活。显示 60 条代表肌腱路径；计算保留 416 个执行器。</p>
 </section>;
}
