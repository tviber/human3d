import fs from 'node:fs';
import path from 'node:path';
import {fixturePng,generateFixture,gradeVision,SCOPE_NOTE,VISION_CHECK_MARKER_COUNT} from './lib/vision-check.mjs';

// Issue #32 work package A: image-plane localization sanity check for agents.
// Run BEFORE reading 2D keypoints off any user reference image.
//
//   node scripts/agent-vision-check.mjs --emit [--out-dir tmp/agent-vision]
//     → writes vision-check.png. Look at the PNG, then write answers.json
//       next to it: {markers:[{id,x,y}…(all ids)],rect:{x,y,w,h}} in PIXELS,
//       origin top-left. Do not read this script's internals for the answer.
//
//   node scripts/agent-vision-check.mjs --check tmp/agent-vision/answers.json
//     → regrades against the deterministic truth and writes
//       vision-check.result.json beside the answers file.
const args=process.argv.slice(2);
const flag=(name)=>{const i=args.indexOf(name);if(i<0)return undefined;const v=args[i+1];args.splice(i,1);if(v===undefined||v.startsWith('--'))return true;args.splice(i,1);return v;};
const outDirFlag=flag('--out-dir');
const checkFlag=flag('--check');
const emitFlag=flag('--emit');
const unknown=args.filter(a=>a.startsWith('--'));
if(unknown.length||(emitFlag===undefined&&checkFlag===undefined)){
 console.error('usage: node scripts/agent-vision-check.mjs --emit [--out-dir <dir>] | --check <answers.json>');
 process.exit(2);
}
if(emitFlag!==undefined){
 const dir=path.resolve(outDirFlag??'tmp/agent-vision');
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'vision-check.png'),fixturePng());
 const template={markers:Array.from({length:VISION_CHECK_MARKER_COUNT},(_,i)=>({id:i+1,x:null,y:null})),rect:{x:null,y:null,w:null,h:null}};
 fs.writeFileSync(path.join(dir,'answers.template.json'),JSON.stringify(template,null,2)+'\n');
 console.log(SCOPE_NOTE);
 console.log(`已生成 ${path.join(dir,'vision-check.png')} 与 answers.template.json。`);
 console.log('查看 PNG（放大约 200% 再读坐标），把全部 10 个圆点中心与红色矩形（左上角+宽高）填进 answers.json，然后运行 --check。');
}else{
 const answersPath=path.resolve(String(checkFlag));
 const answers=JSON.parse(fs.readFileSync(answersPath,'utf8'));
 const grade=gradeVision(answers,generateFixture().truth);
 const resultPath=path.join(path.dirname(answersPath),'vision-check.result.json');
 fs.writeFileSync(resultPath,JSON.stringify({kind:'h3d-vision-check',version:1,...grade},null,2)+'\n');
 console.log(SCOPE_NOTE);
 for(const m of grade.markers)console.log(`  标记 ${String(m.id).padStart(2)}: ${Number.isFinite(m.errorPx)?m.errorPx.toFixed(1)+' px':'缺失/非法'}`);
 if(grade.rect)console.log(`  矩形角点最大误差: ${grade.rect.errorPx.toFixed(1)} px`);
 for(const f of grade.feedback)console.log(`  · ${f}`);
 console.log(`判定: ${grade.verdict.toUpperCase()}（pass ≤4px · warn ≤10px · 其余 fail）→ ${resultPath}`);
 if(grade.verdict==='fail')process.exit(1);
}
