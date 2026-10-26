/** @human3d/motion-core — the shared motion domain.
 *
 * One public entry for everything both apps and the CLIs need: workshop
 * documents and their sampler, the FK/IK solver and kinematics, the motion-file
 * envelope registry, the pose-package protocol (fingerprints, artifact ids,
 * rig manifest body, package capture) and the validators that guard delivered
 * packages. Pure by construction — no DOM, no node imports; `three` is used as
 * a math library only, so the browser bundle, the service and the Node scripts
 * all resolve the same implementation.
 *
 * `glb-export` is deliberately NOT in this barrel: it pulls three's
 * GLTFExporter and is consumed through the `@human3d/motion-core/glb` subpath
 * (workshop button + scripts/package-to-glb.mts). */
export * from './types';
export * from './rig';
export * from './kinematics';
export * from './hand-frame';
export * from './grip';
export * from './hand-shape';
export * from './props';
export * from './semantic-map';
export * from './muscle-action';
export * from './protocol';
export * from './package-const';
export * from './pose-package';
export * from './package-inspect';
export * from './package-export';
export * from './motion-file';
export * from './motion-files';
export * from './motions';
export * from './validate';
export * from './document';
export * from './solver';
export * from './semantic-edit';
export * from './pelvis-schedule';
export * from './foot';
export * from './limits';
export * from './quality-probe';
export * from './generate';
export * from './random-document';
