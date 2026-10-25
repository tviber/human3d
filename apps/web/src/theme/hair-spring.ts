import {DynamicDrawUsage,Matrix4,Vector3,type BufferAttribute,type BufferGeometry} from 'three';
import type {HairLock} from './ssj-hair';

/** One bending mode per stiff lock: x'' = k(goal-x) - c(x'-goal') + gravity.
 * shortcut: an ellipsoid handles head contact; use strand chains for long, loose hair or self-collision.
 */
export class HairSpring{
 private readonly rest:Float32Array;
 private readonly particles:{lock:HairLock;position:Vector3;velocity:Vector3;goal:Vector3;root:Vector3;offset:Vector3;stiffness:number;length:number}[];
 private initialized=false;
 private readonly inverse=new Matrix4();private readonly contact=new Matrix4();private readonly contactInverse=new Matrix4();
 private readonly goal=new Vector3();private readonly root=new Vector3();private readonly target=new Vector3();private readonly goalVelocity=new Vector3();private readonly axis=new Vector3();private readonly delta=new Vector3();private readonly local=new Vector3();
 constructor(private readonly geometry:BufferGeometry,locks:HairLock[],private readonly collider:Matrix4){
  const position=geometry.getAttribute('position') as BufferAttribute;this.rest=new Float32Array(position.array);position.setUsage(DynamicDrawUsage);(geometry.getAttribute('normal') as BufferAttribute).setUsage(DynamicDrawUsage);
  this.particles=locks.map(lock=>{const length=lock.tip.distanceTo(lock.root);return {lock,position:new Vector3(),velocity:new Vector3(),goal:new Vector3(),root:new Vector3(),offset:new Vector3(),length,stiffness:Math.min(2200,Math.max(650,800*(.18/length)**2))};});
  geometry.boundingSphere!.radius+=.025;
 }
 reset(matrix:Matrix4){
  for(const p of this.particles){p.position.copy(p.lock.tip).applyMatrix4(matrix);p.goal.copy(p.position);p.root.copy(p.lock.root).applyMatrix4(matrix);p.velocity.set(0,0,0);p.offset.set(0,0,0);}
  this.initialized=true;this.write(matrix);
 }
 update(dt:number,matrix:Matrix4){this.step(dt,matrix);this.write(matrix);}
 private step(dt:number,matrix:Matrix4){
  if(!this.initialized||!Number.isFinite(dt)||dt<=0||dt>.1){this.reset(matrix);return;}
  this.root.copy(this.particles[0].lock.root).applyMatrix4(matrix);
  if(this.root.distanceTo(this.particles[0].root)>.35){this.reset(matrix);return;}
  this.contact.multiplyMatrices(matrix,this.collider);this.contactInverse.copy(this.contact).invert();
  const steps=Math.ceil(dt*120),h=dt/steps;
  for(const p of this.particles){
   this.goal.copy(p.lock.tip).applyMatrix4(matrix);this.root.copy(p.lock.root).applyMatrix4(matrix);
   this.goalVelocity.copy(this.goal).sub(p.goal).divideScalar(dt);
   const k=p.stiffness,c=2*Math.sqrt(k)*.45;
   for(let i=0;i<steps;i++){
    const t=(i+1)/steps;this.target.copy(p.goal).lerp(this.goal,t);this.local.copy(p.root).lerp(this.root,t);
    p.velocity.addScaledVector(this.delta.copy(this.target).sub(p.position),k*h).addScaledVector(this.goalVelocity,c*h);p.velocity.y-=9.81*h;p.velocity.divideScalar(1+c*h+k*h*h);
    p.position.addScaledVector(p.velocity,h);
    // Keep the authored root-to-tip span and limit the stiff lock's bend to about 10 degrees.
    this.axis.copy(p.position).sub(this.local).normalize();p.position.copy(this.local).addScaledVector(this.axis,p.length);
    this.delta.copy(p.position).sub(this.target).clampLength(0,Math.min(.024,p.length*.18));p.position.copy(this.target).add(this.delta);
    this.axis.copy(p.position).sub(this.local).normalize();this.delta.copy(p.velocity).sub(this.goalVelocity);p.velocity.addScaledVector(this.axis,-this.delta.dot(this.axis));
    this.local.copy(p.position).applyMatrix4(this.contactInverse);
    if(this.local.lengthSq()<1){this.local.normalize();p.position.copy(this.local).applyMatrix4(this.contact);p.velocity.copy(this.goalVelocity);}
   }
   p.goal.copy(this.goal);p.root.copy(this.root);
  }
 }
 /** Static exports converge from rest, independent of playback history or frame rate. */
 settle(matrix:Matrix4){this.reset(matrix);for(let i=0;i<240;i++)this.step(1/120,matrix);this.write(matrix);}
 private write(matrix:Matrix4){
  this.inverse.copy(matrix).invert();
  for(const p of this.particles)p.offset.copy(p.position).applyMatrix4(this.inverse).sub(p.lock.tip);
  const position=this.geometry.getAttribute('position'),flex=this.geometry.getAttribute('hairFlex');
  for(let i=0;i<position.count;i++){
   const offset=this.particles[flex.getX(i)].offset,weight=flex.getY(i),j=i*3;
   position.setXYZ(i,this.rest[j]+offset.x*weight,this.rest[j+1]+offset.y*weight,this.rest[j+2]+offset.z*weight);
  }
  position.needsUpdate=true;this.geometry.computeVertexNormals();
 }
}
