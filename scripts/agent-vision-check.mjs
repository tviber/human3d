import fs from 'node:fs';
import path from 'node:path';
import {createBlindFixture,fixturePng,generateFixture,gradeVision,SCOPE_NOTE,VISION_CHECK_MARKER_COUNT} from './lib/vision-check.mjs';

// Issue #32 work package A: image-plane localization sanity check for agents.
// Run BEFORE reading 2D keypoints off any user reference image.
//
//   node scripts/agent-vision-check.mjs --emit [--out-dir tmp/agent-vision]
//     → writes a randomly-seeded vision-check.png and an answers template.
//       Fill markers:[{id,x,y}…(all ids)] and rect:{x,y,w,h} in PIXELS,
//       origin top-left. Do not read this script's internals for the answer.
//
//   node scripts/agent-vision-check.mjs --check tmp/agent-vision/answers.json
//     → recomputes this challenge's truth from its random seed and writes
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
 const dir=path.resolve(outDirFlag??path.join('tmp',`agent-vision-${Date.now()}-${process.pid}`));
 fs.mkdirSync(dir,{recursive:true});
 const challenge=createBlindFixture();
 fs.writeFileSync(path.join(dir,'vision-check.png'),fixturePng(challenge.seed));
 fs.writeFileSync(path.join(dir,`.vision-check-${challenge.challengeId}.json`),JSON.stringify({seed:challenge.seed})+'\n');
 const template={challengeId:challenge.challengeId,markers:Array.from({length:VISION_CHECK_MARKER_COUNT},(_,i)=>({id:i+1,x:null,y:null})),rect:{x:null,y:null,w:null,h:null}};
 fs.writeFileSync(path.join(dir,'answers.template.json'),JSON.stringify(template,null,2)+'\n');
 console.log(SCOPE_NOTE);
 console.log(`已生成 ${path.join(dir,'vision-check.png')} 与 answers.template.json（挑战 ${challenge.challengeId}）。`);
 console.log('查看 PNG（放大约 200% 再读坐标），把全部 10 个圆点中心与红色矩形（左上角+宽高）填进 answers.json，然后运行 --check。');
}else{
 const answersPath=path.resolve(String(checkFlag));
 const answers=JSON.parse(fs.readFileSync(answersPath,'utf8'));
 if(typeof answers.challengeId!=='string'){console.error('answers.json 缺少 challengeId，请从本次 answers.template.json 填写坐标');process.exit(2);}
 const secretPath=path.join(path.dirname(answersPath),`.vision-check-${answers.challengeId}.json`);
 if(!fs.existsSync(secretPath)){console.error('找不到本次视觉校准挑战；请为当前 answers.json 重新运行 --emit');process.exit(2);}
 const secret=JSON.parse(fs.readFileSync(secretPath,'utf8'));
 const grade=gradeVision(answers,generateFixture({seed:secret.seed}).truth);
 const resultPath=path.join(path.dirname(answersPath),'vision-check.result.json');
 fs.writeFileSync(resultPath,JSON.stringify({kind:'h3d-vision-check',version:1,challengeId:answers.challengeId,...grade},null,2)+'\n');
 console.log(SCOPE_NOTE);
 for(const m of grade.markers)console.log(`  标记 ${String(m.id).padStart(2)}: ${Number.isFinite(m.errorPx)?m.errorPx.toFixed(1)+' px':'缺失/非法'}`);
 if(grade.rect)console.log(`  矩形角点最大误差: ${grade.rect.errorPx.toFixed(1)} px`);
 for(const f of grade.feedback)console.log(`  · ${f}`);
 console.log(`判定: ${grade.verdict.toUpperCase()}（pass ≤4px · warn ≤10px · 其余 fail）→ ${resultPath}`);
 if(grade.verdict==='fail')process.exit(1);
}
