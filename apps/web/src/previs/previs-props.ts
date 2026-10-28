import * as THREE from 'three';
import type {PrevisProp} from '@mioon/contracts';

// Prop meshes. A prop's origin is the middle of its base, so it stands on the
// floor at y = position[1]; it faces +Z at rotation 0. Sizes are width, height
// and depth in metres; a cylinder or sphere uses the width as its diameter.
export interface PrevisPropMaterials {readonly surface: THREE.Material; readonly dark: THREE.Material; readonly canopy: THREE.Material}
const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, y: number): THREE.Mesh => {
  const value = new THREE.Mesh(geometry, material);
  value.position.y = y; value.castShadow = true; value.receiveShadow = true;
  return value;
};
/** A new group for one prop; the caller disposes its geometries when it is replaced. */
export function createPrevisPropObject(kind: PrevisProp['kind'], size: readonly [number, number, number], materials: PrevisPropMaterials): THREE.Group {
  const [width, height, depth] = size, group = new THREE.Group();
  switch (kind) {
    case 'box': case 'panel': group.add(mesh(new THREE.BoxGeometry(width, height, depth), materials.surface, height / 2)); break;
    case 'cylinder': group.add(mesh(new THREE.CylinderGeometry(width / 2, width / 2, height, 32), materials.surface, height / 2)); break;
    case 'sphere': group.add(mesh(new THREE.SphereGeometry(width / 2, 32, 18), materials.surface, width / 2)); break;
    case 'umbrella': {
      // An eight-panel canopy over a thin shaft; the grip is at the base.
      const canopyHeight = Math.min(0.3, height * 0.3), shaft = Math.max(0.05, height - canopyHeight * 0.4);
      group.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, shaft, 8), materials.dark, shaft / 2));
      group.add(mesh(new THREE.ConeGeometry(width / 2, canopyHeight, 8, 1, true), materials.canopy, height - canopyHeight / 2));
      break;
    }
    case 'phone': group.add(mesh(new THREE.BoxGeometry(width, height, depth), materials.dark, height / 2)); break;
    case 'bag': {
      const handle = Math.min(0.12, height * 0.4);
      group.add(mesh(new THREE.BoxGeometry(width, height - handle, depth), materials.surface, (height - handle) / 2));
      const loop = mesh(new THREE.TorusGeometry(Math.min(width * 0.3, handle), 0.008, 6, 20, Math.PI), materials.dark, height - handle);
      group.add(loop);
      break;
    }
    case 'cup': group.add(mesh(new THREE.CylinderGeometry(width / 2, width / 2 * 0.85, height, 24), materials.surface, height / 2)); break;
  }
  return group;
}
/** Where a held prop sits relative to the grip in its holder's hand, in its own frame. */
export function previsHeldOffset(kind: PrevisProp['kind'], size: readonly [number, number, number]): [number, number, number] {
  if (kind === 'umbrella') return [0, -0.06, 0];
  if (kind === 'bag') return [0, -size[1], 0];
  return [0, -size[1] / 2, 0.02];
}
export function disposePrevisObject(object: THREE.Object3D): void {
  object.traverse(child => { if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).geometry.dispose(); });
}
