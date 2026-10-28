import * as THREE from 'three';
import type {PrevisFigure,PrevisProp} from '@mioon/contracts';

// A procedural wooden-mannequin figure about 1.75 m tall, built from spheres,
// capsules and boxes so no model file ships with the app. The figure stands on
// y = 0 and faces +Z; its left side is +X. Each pose is a set of joint angles.
// A joint swinging a hanging limb by a negative X angle moves it forward.
export type PrevisJoint = 'hips' | 'spine' | 'chest' | 'neck' | 'shoulderL' | 'elbowL' | 'wristL' | 'shoulderR' | 'elbowR' | 'wristR' |
  'hipL' | 'kneeL' | 'ankleL' | 'hipR' | 'kneeR' | 'ankleR';
type Angles = Partial<Record<PrevisJoint, readonly [number, number, number]>>;
interface PoseSpec {readonly hipsY: number; readonly angles: Angles}
const HIPS_Y = 0.94;
const BASE: Angles = {shoulderL: [0, 0, 0.12], shoulderR: [0, 0, -0.12], elbowL: [-0.1, 0, 0], elbowR: [-0.1, 0, 0]};
const POSES: Readonly<Record<PrevisFigure['pose'], PoseSpec>> = {
  stand: {hipsY: 0, angles: BASE},
  walk: {hipsY: -0.05, angles: {spine: [0, 0.06, 0], hipL: [-0.42, 0, 0], kneeL: [0.12, 0, 0], ankleL: [0.1, 0, 0], hipR: [0.32, 0, 0], kneeR: [0.55, 0, 0], ankleR: [-0.2, 0, 0],
    shoulderL: [0.3, 0, 0.08], shoulderR: [-0.3, 0, -0.08], elbowL: [-0.35, 0, 0], elbowR: [-0.35, 0, 0]}},
  sit: {hipsY: -0.38, angles: {spine: [0.05, 0, 0], hipL: [-1.45, 0, 0.04], hipR: [-1.45, 0, -0.04], kneeL: [1.45, 0, 0], kneeR: [1.45, 0, 0],
    shoulderL: [-0.45, 0, 0.1], shoulderR: [-0.45, 0, -0.1], elbowL: [-0.55, 0, 0], elbowR: [-0.55, 0, 0]}},
  hold: {hipsY: 0, angles: BASE},
  'look-back': {hipsY: 0, angles: {...BASE, spine: [0, 0.25, 0], chest: [0, 0.25, 0], neck: [0, 0.7, 0], shoulderL: [0.15, 0, 0.12]}},
};
// The holding arm: raised in front of the chest, or higher under an umbrella.
const HOLD_ARM = {shoulder: [-0.55, 0, 0.1], elbow: [-1.25, 0, 0], wrist: [0.2, 0, 0]} as const;
const UMBRELLA_ARM = {shoulder: [-0.35, 0, 0.12], elbow: [-1.75, 0, 0], wrist: [0.25, 0, 0]} as const;

export interface PrevisMannequin {
  readonly group: THREE.Group;
  readonly joints: Readonly<Record<PrevisJoint, THREE.Group>>;
  /** Where a held prop's grip is, inside each hand. */
  readonly grips: {readonly left: THREE.Object3D; readonly right: THREE.Object3D};
  setPose(pose: PrevisFigure['pose'], held: {kind: PrevisProp['kind']; hand: 'left' | 'right'} | null): void;
}
export interface PrevisMannequinMaterials {readonly body: THREE.Material; readonly joint: THREE.Material}
// Geometry is shared by every figure of a viewport and released with it.
export function createMannequinGeometry() {
  return {
    head: new THREE.SphereGeometry(0.1, 24, 16), neck: new THREE.CylinderGeometry(0.04, 0.045, 0.1, 12),
    // The chest widens from the waist to the shoulders; the pelvis is a flattened bowl.
    chest: lathe([[0, 0], [0.1, 0], [0.122, 0.06], [0.148, 0.15], [0.156, 0.22], [0.138, 0.272], [0.085, 0.3], [0, 0.305]]),
    abdomen: new THREE.SphereGeometry(0.1, 20, 14),
    pelvis: lathe([[0, -0.1], [0.085, -0.096], [0.122, -0.055], [0.134, 0], [0.12, 0.038], [0, 0.05]]),
    upperArm: new THREE.CapsuleGeometry(0.045, 0.2, 6, 12), forearm: new THREE.CapsuleGeometry(0.04, 0.17, 6, 12), hand: new THREE.SphereGeometry(0.045, 12, 10),
    thigh: new THREE.CapsuleGeometry(0.065, 0.3, 6, 14), shin: new THREE.CapsuleGeometry(0.05, 0.32, 6, 12), foot: new THREE.BoxGeometry(0.09, 0.06, 0.24),
    joint: new THREE.SphereGeometry(1, 14, 10),
  };
}
export type PrevisMannequinGeometry = ReturnType<typeof createMannequinGeometry>;
function lathe(profile: readonly (readonly [number, number])[]): THREE.LatheGeometry {
  return new THREE.LatheGeometry(profile.map(([radius, y]) => new THREE.Vector2(radius, y)), 28);
}

export function createMannequin(geometry: PrevisMannequinGeometry, materials: PrevisMannequinMaterials): PrevisMannequin {
  const group = new THREE.Group();
  const joint = (parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group => { const value = new THREE.Group(); value.position.set(x, y, z); parent.add(value); return value; };
  const part = (parent: THREE.Object3D, shape: THREE.BufferGeometry, [x, y, z]: readonly number[], scale: readonly number[] = [1, 1, 1], material = materials.body): THREE.Mesh => {
    const mesh = new THREE.Mesh(shape, material);
    mesh.position.set(x!, y!, z!); mesh.scale.set(scale[0]!, scale[1]!, scale[2]!); mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh); return mesh;
  };
  const ball = (parent: THREE.Object3D, radius: number): THREE.Mesh => part(parent, geometry.joint, [0, 0, 0], [radius, radius, radius], materials.joint);
  const hips = joint(group, 0, HIPS_Y, 0);
  part(hips, geometry.pelvis, [0, 0, 0], [1, 1, 0.74]);
  const spine = joint(hips, 0, 0.1, 0);
  part(spine, geometry.abdomen, [0, 0.03, 0], [1, 0.95, 0.68]);
  const chest = joint(spine, 0, 0.12, 0);
  part(chest, geometry.chest, [0, 0, 0], [1, 1, 0.6]);
  const neck = joint(chest, 0, 0.29, 0);
  ball(neck, 0.04);
  part(neck, geometry.neck, [0, 0.04, 0]);
  part(neck, geometry.head, [0, 0.16, 0.005], [0.9, 1.15, 1]);
  const arm = (side: 1 | -1) => {
    const shoulder = joint(chest, 0.18 * side, 0.21, 0);
    ball(shoulder, 0.05);
    part(shoulder, geometry.upperArm, [0, -0.145, 0]);
    const elbow = joint(shoulder, 0, -0.29, 0);
    ball(elbow, 0.04);
    part(elbow, geometry.forearm, [0, -0.125, 0]);
    const wrist = joint(elbow, 0, -0.25, 0);
    ball(wrist, 0.03);
    part(wrist, geometry.hand, [0, -0.05, 0], [0.8, 1.3, 0.5]);
    const grip = new THREE.Object3D(); grip.position.set(0, -0.06, 0.01); wrist.add(grip);
    return {shoulder, elbow, wrist, grip};
  };
  const leg = (side: 1 | -1) => {
    const hip = joint(hips, 0.095 * side, -0.04, 0);
    ball(hip, 0.055);
    part(hip, geometry.thigh, [0, -0.215, 0]);
    const knee = joint(hip, 0, -0.43, 0);
    ball(knee, 0.048);
    part(knee, geometry.shin, [0, -0.21, 0]);
    const ankle = joint(knee, 0, -0.42, 0);
    ball(ankle, 0.035);
    part(ankle, geometry.foot, [0, -0.02, 0.06]);
    return {hip, knee, ankle};
  };
  const left = arm(1), right = arm(-1), legL = leg(1), legR = leg(-1);
  const joints: Record<PrevisJoint, THREE.Group> = {hips, spine, chest, neck, shoulderL: left.shoulder, elbowL: left.elbow, wristL: left.wrist,
    shoulderR: right.shoulder, elbowR: right.elbow, wristR: right.wrist, hipL: legL.hip, kneeL: legL.knee, ankleL: legL.ankle, hipR: legR.hip, kneeR: legR.knee, ankleR: legR.ankle};
  function setPose(pose: PrevisFigure['pose'], held: {kind: PrevisProp['kind']; hand: 'left' | 'right'} | null): void {
    const spec = POSES[pose] ?? POSES.stand;
    for (const value of Object.values(joints)) value.rotation.set(0, 0, 0);
    hips.position.y = HIPS_Y + spec.hipsY;
    for (const [name, angles] of Object.entries(spec.angles) as [PrevisJoint, readonly [number, number, number]][]) joints[name].rotation.set(angles[0], angles[1], angles[2]);
    // An umbrella is always held up; in the hold pose the holding hand comes up to the chest.
    const raise = held?.kind === 'umbrella' ? UMBRELLA_ARM : pose === 'hold' ? HOLD_ARM : null;
    if (raise) {
      const hand = held?.hand ?? 'right', side = hand === 'left' ? 1 : -1, suffix = hand === 'left' ? 'L' : 'R';
      joints[`shoulder${suffix}`].rotation.set(raise.shoulder[0], raise.shoulder[1], raise.shoulder[2] * side);
      joints[`elbow${suffix}`].rotation.set(raise.elbow[0], raise.elbow[1], raise.elbow[2]);
      joints[`wrist${suffix}`].rotation.set(raise.wrist[0], raise.wrist[1], raise.wrist[2]);
    }
  }
  setPose('stand', null);
  return {group, joints, grips: {left: left.grip, right: right.grip}, setPose};
}
