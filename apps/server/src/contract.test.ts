import {describe,it,expect,beforeAll} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {createContract,readSpec,type Contract} from './contract';
import {motionDefinitionPayload,normalizeMotionFile,unwrapMotionFile} from '@human3d/motion-core';
import {MOTION_FILES} from '@human3d/motion-core';
import {MOTIONS,muscleActionById} from '@human3d/motion-core';
import {load as loadYaml} from 'js-yaml';
import {createService,handleRequest,LIMITS_SVC,type ServiceContext} from './service';
import {ERROR_CODES} from './errors';
import {validatePosePackage} from '@human3d/motion-core';
import type {PosePackage} from '@human3d/motion-core';

const SPEC=path.resolve('spec');
let contract:Contract;
let ctx:ServiceContext;
beforeAll(async()=>{contract=createContract();ctx=await createService('public');},30000);
const read=(rel:string)=>JSON.parse(fs.readFileSync(path.join(SPEC,rel),'utf8'));

describe('executable contract',()=>{
 it('compiles every published schema in strict Ajv 2020 mode',()=>{
  expect(()=>createContract()).not.toThrow();
  expect(readSpec('motion-request.schema.json')).toBeTruthy();
  expect(readSpec('pose-package.schema.json')).toBeTruthy();
 });
 it('accepts the minimal request and rejects each envelope violation',()=>{
  expect(contract.request({action:{id:'idle'}})).toBe(true);
  expect(contract.request({action:{id:'idle'},sample:{fps:61}})).toBe(false);
  expect(contract.request({action:{id:'idle'},sample:{fps:0}})).toBe(false);
  expect(contract.request({action:{id:'idle'},extra:true})).toBe(false);
  expect(contract.request({action:{id:''}})).toBe(false);
  expect(contract.request({action:{id:'idle',parameters:[]}})).toBe(false);
  expect(contract.request({action:{id:'idle'},outputs:[1,2,3,4,5].map(()=>({kind:'motion',format:'pose-json'}))})).toBe(false);
 });
 it('accepts the published request example',()=>{
  expect(contract.request(read('examples/rejected-pelvis-fold.request.json'))).toBe(true);
 });
 it('refuses schemaVersion 1 documents instead of upgrading them',()=>{
  // The advertised contract says v2 only. The runtime must agree: an old
  // document is a validation failure, never a silent migration.
  const v1=JSON.parse(JSON.stringify(read('examples/rejected-pelvis-fold.request.json'))) as {
   action:{parameters:{document:Record<string,unknown>}}};
  const doc=v1.action.parameters.document;
  delete doc.loop;delete doc.handFrames;doc.schemaVersion=1;
  expect(contract.request(v1)).toBe(true); // envelope is valid — the document is not
  const r=handleRequest(ctx,'POST','/v1/motions',v1,{});
  expect(r.status).toBe(400);
  const body=r.body as {error:{code:string;message:string}};
  expect(body.error.code).toBe('validation_failed');
  expect(body.error.message).toContain('schemaVersion');
 });
 it('advertises v2-only documents, never an upgrade path',()=>{
  const a=handleRequest(ctx,'GET','/v1/actions/workshop-doc').body as {
   parameters:{properties:{document:{description:string}}}};
  const desc=a.parameters.properties.document.description;
  expect(desc).not.toMatch(/are upgraded on input/i);
  expect(desc).toMatch(/schemaVersion must be 2/);
  expect(desc).toMatch(/refused|never silently upgraded/);
 });
 it('rejects foreign package versions and malformed quality codes',()=>{
  const pkg=read('examples/idle.pose.json');
  expect(contract.posePackage(pkg)).toBe(true);
  expect(contract.posePackage({...pkg,schemaVersion:1})).toBe(false);
  const bad=JSON.parse(JSON.stringify(pkg));
  bad.quality.checks[0].code='Foot Depth';
  expect(contract.posePackage(bad)).toBe(false);
  const badSide=JSON.parse(JSON.stringify(pkg));
  badSide.events.push({time:0,label:'x',type:'support-start',side:'X'});
  expect(contract.posePackage(badSide)).toBe(false);
 });
});

describe('golden examples',()=>{
 it('the published idle package is schema-valid and passes the semantic validator',()=>{
  const pkg=read('examples/idle.pose.json') as PosePackage;
  expect(contract.posePackage(pkg),JSON.stringify(contract.posePackage.errors)).toBe(true);
  expect(validatePosePackage(pkg,ctx.manifest)).toEqual([]);
 });
 it('every served bundled action matches the published package schema',()=>{
  for(const id of ['idle','reach','squat','ready','forehand']){
   const r=handleRequest(ctx,'POST','/v1/motions',{action:{id}},{});
   expect(r.status).toBe(200);
   expect(contract.posePackage(r.body),id).toBe(true);
  }
 });
});

describe('forehand-study example (WP-C acceptance fixture)',()=>{
 /* Authored through the live workshop UI (see spec/examples/forehand-study.md
  * for the editing ledger): five keys covering preparation → backswing →
  * contact → follow-through → recovery over 2 s, both feet planted
  * throughout, pelvis hand frames, exactly one contact key. */
 const req=read('examples/forehand-study.request.json');
 const doc=req.action.parameters.document;
 it('is a schema-valid workshop-doc request the service accepts',()=>{
  expect(contract.request(req),JSON.stringify(contract.request.errors)).toBe(true);
  const r=handleRequest(ctx,'POST','/v1/motions',req,{});
  expect(r.status,JSON.stringify(r.body)).toBe(200);
  expect(contract.posePackage(r.body),JSON.stringify(contract.posePackage.errors)).toBe(true);
  expect(validatePosePackage(r.body as PosePackage,ctx.manifest)).toEqual([]);
 });
 it('carries the study structure: ≤5 keys, one contact, double plant, pelvis frames',()=>{
  expect(req.action.id).toBe('workshop-doc');
  expect(doc.keys.length).toBeLessThanOrEqual(5);
  expect(doc.keys.filter((k:{constraints:{contact:boolean}})=>k.constraints.contact)).toHaveLength(1);
  for(const k of doc.keys){
   expect(k.constraints.plantL,`${k.id} plantL`).toBe(true);
   expect(k.constraints.plantR,`${k.id} plantR`).toBe(true);
  }
  expect(doc.handFrames).toEqual({L:'pelvis',R:'pelvis'});
 });
});

describe('motion file envelopes',()=>{
 const dir=path.resolve('assets/motions');
 const ajv=new Ajv2020({allErrors:true,strict:true});
 const check=ajv.compile(JSON.parse(fs.readFileSync(path.join(dir,'motion.schema.json'),'utf8')));
 const checkAction=ajv.compile(JSON.parse(fs.readFileSync(path.join(dir,'dynamics-action.schema.json'),'utf8')));
 const readMotion=(name:string)=>JSON.parse(fs.readFileSync(path.join(dir,`${name}.json`),'utf8'));
 it('every assets/motions/*.json satisfies its published schema and normalizes',()=>{
  const files=fs.readdirSync(dir).filter(n=>n.endsWith('.json')&&!n.endsWith('.schema.json')).sort();
  expect(files).toEqual([
   'baseball-throw.json','basic-arms-up.json','basic-forward-fold.json','basic-full-squat.json','basic-half-squat.json',
   'basic-lunge.json','basic-push-turn.json','basic-weight-shift.json','basic-wide-squat.json',
   'forehand.json','idle.json','punch.json','reach.json','ready.json',
   'squat.json','walk.json',
  ]);
  for(const name of files){
   const raw=readMotion(name.replace('.json',''));
   expect(check(raw),`${name}: ${JSON.stringify(check.errors)}`).toBe(true);
   expect(()=>normalizeMotionFile(raw),name).not.toThrow();
  }
 });
 it('enforces the document/clip/dynamics kind exclusivity on both schema and runtime validator',()=>{
  const idle=readMotion('idle');
  const walk=readMotion('walk');
  const throwMotion=readMotion('baseball-throw');
  const drop=(o:Record<string,unknown>,k:string)=>{const c={...o};delete c[k];return c;};
  const bad=[
   {...idle,clip:{url:'/x.json'}},          // workshop-motion carrying a clip
   {...walk,document:idle.document},       // clip-motion embedding a document
   drop(idle,'document'),                  // workshop-motion without document
   drop(walk,'clip'),                      // clip-motion without clip
   {...throwMotion,document:idle.document},// dynamics-motion carrying a document
   {...throwMotion,clip:{url:'/x.json'}},  // dynamics-motion carrying a clip
   drop(throwMotion,'dynamics'),           // dynamics-motion without dynamics
   {...throwMotion,name:'影子字段'},        // dynamics-motion writing a derived display field
  ];
  for(const b of bad){
   expect(check(b),JSON.stringify(check.errors)).toBe(false);
   expect(()=>normalizeMotionFile(b)).toThrow();
  }
 });
 it('refuses envelopes whose cross-field data disagrees',()=>{
  const idle=readMotion('idle');
  const walk=readMotion('walk');
  // The JSON schema cannot express field-to-field consistency — the runtime
  // validator is the gate. Assert the schema accepts these shapes so the
  // runtime check is proven to add coverage rather than restate the schema.
  const durationMismatch={...idle,duration:idle.duration+1};
  expect(check(durationMismatch)).toBe(true);
  expect(()=>normalizeMotionFile(durationMismatch)).toThrow(/不一致/);
  const phasePastEnd={...idle,phases:[{time:idle.duration+.5,label:'越界'}]};
  expect(check(phasePastEnd)).toBe(true);
  expect(()=>normalizeMotionFile(phasePastEnd)).toThrow(/phases/);
  // The same phases range applies to clip-motion envelopes.
  const clipPhasePastEnd={...walk,phases:[{time:walk.duration+.5,label:'越界'}]};
  expect(()=>normalizeMotionFile(clipPhasePastEnd)).toThrow(/phases/);
  const negativePhase={...idle,phases:[{time:-.1,label:'负'}]};
  expect(()=>normalizeMotionFile(negativePhase)).toThrow(/phases/);
  // Legal envelopes are untouched by the new guards.
  expect(()=>normalizeMotionFile(idle)).not.toThrow();
  expect(()=>normalizeMotionFile(walk)).not.toThrow();
 });
 it('validates dynamics.action against the dynamics-action schema',()=>{
  for(const name of ['baseball-throw','punch']){
   const raw=readMotion(name);
   expect(checkAction(raw.dynamics.action),`${name}: ${JSON.stringify(checkAction.errors)}`).toBe(true);
  }
 });
 it('every dynamics.records URL resolves to a real public file',()=>{
  // The envelope's records paths are the runtime fetch contract; assert the
  // files exist so a path move without a records update fails here.
  for(const f of MOTION_FILES.filter(f=>f.kind==='dynamics-motion')){
   for(const ref of Object.values(f.dynamics!.records)){
    for(const url of [ref.meta,ref.data])
     expect(fs.existsSync(path.resolve('public',url.replace(/^\//,''))),`${f.id}: ${url}`).toBe(true);
   }
  }
 });
 it('derives the same dynamics MotionSpec display values the glob registry produced',()=>{
  // Field-by-field baseline pinned from the pre-registry importer output
  // (git show HEAD~:src/core/motions.ts actionMotions). Duration keeps the
  // simulation-grid rounding; phases default from keyframe times.
  const expected:Record<string,unknown>={
   'baseball-throw':{id:'baseball-throw',name:'原地棒球式上手投掷',english:'IN-PLACE BASEBALL THROW · NO OBJECT',
    duration:3.8120000000000003,
    description:'原地棒球式上手投掷：先屈膝并让右手在头后蓄力，骨盆和胸廓依次转向，手臂向前伸展；释放时张开手指，无球，随后前屈随挥。',
    method:'MyoSim 肌肉正向仿真 · 皮肤腕 / 手指按关节关键帧显示',
    focus:['双脚固定、脚尖外展','髋盆先行、躯干滞后跟进','高位引臂、肘部逐步伸展','腕部后伸到屈曲、手指在释放时张开'],
    phases:[{time:0.3,label:'准备'},{time:0.7166667,label:'引臂蓄力'},{time:1.1333333,label:'最大蓄力 / 肩外展'},{time:1.5,label:'蹬地与骨盆启动'},{time:1.8833333,label:'躯干跟进'},{time:2.3,label:'肩肘加速与释放'},{time:2.8833333,label:'随挥制动'},{time:3.4666667,label:'恢复'}],
    oneShot:true},
   punch:{id:'punch',name:'后手直拳 · 后下收拳',english:'MUSCLE-DRIVEN REAR-HAND STRAIGHT PUNCH',duration:3.2,
    description:'后手直拳：出拳拳从同侧后下方收起，双腿稳定支撑、骨盆和躯干转动后，右拳沿自身肩线直线向前推出；左拳始终贴近脸侧护住下颌，肘部收在肋侧。击出后回收到紧凑的身体前侧待发位。',
    method:'MyoSim 肌肉正向仿真 · 右拳关键帧跟踪 · 左拳闭合护架',
    focus:['右拳后下方起势，不向身体外侧摆出','骨盆、躯干、肩肘依次加速','拳路以前向为主，肘腕保持同轴','左拳贴脸护架，肘部收住','双手 MCP / PIP / DIP 与拇指对掌'],
    phases:[{time:0.2,label:'后下收拳 / 左拳护颊'},{time:0.48,label:'稳固蓄势'},{time:0.8,label:'骨盆启动'},{time:1.3,label:'躯干跟进'},{time:1.7,label:'直线伸拳'},{time:1.975,label:'短暂停留'},{time:2.575,label:'回收到护架'},{time:2.95,label:'紧凑回收'}],
    oneShot:false},
  };
  for(const id of Object.keys(expected)){
   const spec=MOTIONS.find(m=>m.id===id)!;
   for(const [key,value]of Object.entries(expected[id] as Record<string,unknown>))
    expect(spec[key as keyof typeof spec],`${id}.${key}`).toEqual(value);
   const file=MOTION_FILES.find(f=>f.id===id)!;
   expect(file.kind).toBe('dynamics-motion');
   expect(spec.source).toEqual({kind:'dynamics',action:file.dynamics!.action,records:file.dynamics!.records});
   expect(muscleActionById(id)).toBe(file.dynamics!.action);
  }
 });
 it('refuses to unwrap or hash a dynamics-motion through the workshop pipeline',()=>{
  const file=MOTION_FILES.find(f=>f.id==='baseball-throw')!;
  expect(()=>unwrapMotionFile({...file})).toThrow(/dynamics-motion/);
  expect(()=>motionDefinitionPayload(file)).toThrow(/dynamics-motion/);
 });
});

describe('OpenAPI description matches the executable contract',()=>{
 const doc=loadYaml(fs.readFileSync(path.join(SPEC,'openapi.yaml'),'utf8')) as Record<string,any>;
 it('documents exactly the error codes the service can emit',()=>{
  const enumCodes:string[]=doc.components.schemas.Error.properties.error.properties.code.enum;
  expect([...enumCodes].sort()).toEqual([...ERROR_CODES].sort());
 });
 it('states the Idempotency-Key bounds the service enforces',()=>{
  const header=doc.paths['/v1/motions'].post.parameters.find((p:{name:string})=>p.name==='Idempotency-Key');
  expect(header.schema.maxLength).toBe(LIMITS_SVC.idempotencyKeyMaxLength);
  expect(header.schema.pattern).toBe(`^[!-~]{1,${LIMITS_SVC.idempotencyKeyMaxLength}}$`);
 });
 it('resolves every $ref to an existing component or spec file',()=>{
  const refs:string[]=[];
  const walk=(v:unknown)=>{
   if(Array.isArray(v))v.forEach(walk);
   else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){if(k==='$ref'&&typeof x==='string')refs.push(x);else walk(x);}
  };
  walk(doc);
  expect(refs.length).toBeGreaterThan(5);
  for(const ref of refs){
   if(ref.startsWith('#/')){
    let node:unknown=doc;
    for(const seg of ref.slice(2).split('/'))node=(node as Record<string,unknown>)?.[seg];
    expect(node,ref).toBeDefined();
   }else expect(fs.existsSync(path.join(SPEC,ref)),ref).toBe(true);
  }
 });
 it('documents every endpoint the service advertises, and no other',()=>{
  const served=(handleRequest(ctx,'GET','/v1/capabilities').body as {endpoints:string[]}).endpoints;
  const documented=Object.entries(doc.paths).flatMap(([p,ops])=>Object.keys(ops as object).map(m=>`${m.toUpperCase()} ${p}`));
  expect([...documented].sort()).toEqual([...served].sort());
 });
 it('documents v2-only documents, matching the served descriptor',()=>{
  const desc=doc.components.schemas.MotionRequest.properties.action.properties.parameters.description as string;
  expect(desc).not.toMatch(/are upgraded on input/i);
  expect(desc).toMatch(/`schemaVersion` must be 2/);
  expect(desc).toMatch(/refused|never\s+silently upgraded/);
  const served=(handleRequest(ctx,'GET','/v1/actions/workshop-doc').body as {
   parameters:{properties:{document:{description:string}}}}).parameters.properties.document.description;
  expect(served).toContain('schemaVersion must be 2');
 });
});
