import * as THREE from 'three';
import type {PrevisCamera,PrevisScene} from '@mioon/contracts';
import {normalizePrevisCamera,orbitPrevisCamera,previsFrameRect,previsLightDirection,previsViewportFov,turnPrevisCamera,walkPrevisCamera} from './previs-camera.ts';
import type {Vector3} from './previs-camera.ts';
import {PREVIS_LIGHT_SELECTION,previsOrbitPivot,previsSceneCenter} from './previs-editor-state.ts';
import type {PrevisSelection} from './previs-editor-state.ts';
import {createMannequin,createMannequinGeometry} from './previs-mannequin.ts';
import type {PrevisMannequin} from './previs-mannequin.ts';
import {createPrevisPropObject,disposePrevisObject,previsHeldOffset} from './previs-props.ts';

// The editor's 3D view. It renders in the browser with three.js, only when
// something changed or while the camera moves, and looks through the scene
// camera itself: the frame guide in the middle is exactly the output frame.
// React owns the overlay elements (labels, selection corners, the light line);
// this module only places them. The camera and a dragged element move here
// live and are reported in short intervals, and once more when they stop.
export type PrevisViewMode = 'orbit' | 'free';
export interface PrevisViewportInput {
  readonly scene: PrevisScene;
  readonly selection: PrevisSelection;
  readonly mode: PrevisViewMode;
  readonly readOnly: boolean;
  /** Width over height of the output frame. */
  readonly aspect: number;
}
export interface PrevisViewportEvents {
  select(selection: PrevisSelection): void;
  move(id: string, position: Vector3, final: boolean): void;
  camera(camera: PrevisCamera, final: boolean): void;
  lost?(lost: boolean): void;
}
export interface PrevisCapture {readonly dataBase64: string; readonly width: number; readonly height: number}
export interface PrevisViewport {
  update(input: PrevisViewportInput): void;
  /** A JPEG of what the camera sees now, at most `maxEdge` pixels long: the
   * output frame, or a wide 16:9 view around it for the canvas card. */
  capture(maxEdge: number, maxBytes: number, region?: 'frame' | 'wide'): Promise<PrevisCapture | null>;
  /** True while the user is moving the camera or an element. */
  busy(): boolean;
  dispose(): void;
}
const BACKGROUND = 0x0d0e10, EMIT_MS = 90, WALK_SPEED = 1.6, KEY_LIGHT = 2.4;
const MOVEMENT = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight']);
const radians = THREE.MathUtils.degToRad;
const round = (value: number): number => Math.round(value * 1000) / 1000 || 0;
const clampCoordinate = (value: number): number => round(Math.min(100, Math.max(-100, value)));

function blobBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  });
}

/** Null when this browser cannot create a WebGL context. */
export function createPrevisViewport(host: HTMLElement, overlay: HTMLElement, events: PrevisViewportEvents): PrevisViewport | null {
  // three.js needs WebGL 2; probe first so an unavailable context is a quiet fallback.
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) return null;
  probe.getExtension('WEBGL_lose_context')?.loseContext();
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'}); }
  catch { return null; }
  if (!renderer.getContext()) { renderer.dispose(); return null; }
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.setClearColor(BACKGROUND);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'previs-viewport-canvas';
  host.prepend(canvas);

  const world = new THREE.Scene();
  world.background = new THREE.Color(BACKGROUND);
  world.fog = new THREE.Fog(BACKGROUND, 16, 42);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  camera.rotation.order = 'YXZ';
  const floorGeometry = new THREE.PlaneGeometry(200, 200), floorMaterial = new THREE.MeshStandardMaterial({color: 0x101113, roughness: 1, metalness: 0});
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  const grid = new THREE.GridHelper(40, 40, 0x4a4e55, 0x2e3136);
  grid.position.y = 0.002;
  (grid.material as THREE.Material).depthWrite = false;
  const ambient = new THREE.HemisphereLight(0xdfe5ec, 0x18181a, 0.85);
  const key = new THREE.DirectionalLight(0xffffff, KEY_LIGHT);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, {left: -8, right: 8, top: 8, bottom: -8, near: 0.5, far: 40});
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 3;
  world.add(floor, grid, ambient, key, key.target);

  const mannequinGeometry = createMannequinGeometry();
  const bodyMaterial = new THREE.MeshStandardMaterial({color: 0xd8d8d8, roughness: 0.55, metalness: 0});
  const jointMaterial = new THREE.MeshStandardMaterial({color: 0x8c8c8c, roughness: 0.5, metalness: 0});
  const propMaterials = {surface: new THREE.MeshStandardMaterial({color: 0xb3b5b8, roughness: 0.75, metalness: 0}),
    dark: new THREE.MeshStandardMaterial({color: 0x2e3033, roughness: 0.6, metalness: 0.1}),
    canopy: new THREE.MeshStandardMaterial({color: 0xdcdcdc, roughness: 0.6, metalness: 0, side: THREE.DoubleSide})};
  const figures = new Map<string, {mannequin: PrevisMannequin; pose: string}>();
  const props = new Map<string, {group: THREE.Group; shape: string}>();

  let input: PrevisViewportInput | null = null, live: PrevisCamera | null = null, frame = 0, disposed = false, lost = false;
  type Gesture = {kind: 'drag'; id: string; pointerId: number; plane: THREE.Plane; offset: THREE.Vector3; moved: boolean; x: number; y: number}
    | {kind: 'orbit' | 'look' | 'pan'; pointerId: number; pivot: Vector3; moved: boolean; x: number; y: number; startX: number; startY: number; empty: boolean};
  let gesture: Gesture | null = null, dragPosition: Vector3 | null = null;
  // A dropped element keeps its place until the editor's next update carries it.
  let settled: {id: string; position: Vector3} | null = null;
  const keys = new Set<string>();
  let walking = 0, walkedAt = 0, wheelTimer: ReturnType<typeof setTimeout> | null = null;
  let emitTimer: ReturnType<typeof setTimeout> | null = null, emittedAt = 0, moveTimer: ReturnType<typeof setTimeout> | null = null, movedAt = 0;

  const size = (): {width: number; height: number} => ({width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight)});
  const cameraBusy = (): boolean => Boolean(gesture && gesture.kind !== 'drag') || keys.size > 0 || wheelTimer !== null;
  function applyCamera(): void {
    if (!live || !input) return;
    const {width, height} = size(), rect = previsFrameRect(width, height, input.aspect);
    camera.position.set(live.position[0], live.position[1], live.position[2]);
    camera.rotation.set(radians(live.pitch), radians(live.yaw), 0);
    camera.aspect = width / height;
    camera.fov = previsViewportFov(live.focalLength, input.aspect, height, rect.height);
    camera.updateProjectionMatrix();
  }
  // ---- Scene objects ----
  function heldBy(scene: PrevisScene, propId: string) { return scene.figures.find(item => item.held?.propId === propId) ?? null; }
  function sync(): void {
    if (!input) return;
    const scene = input.scene, dragging = gesture?.kind === 'drag' ? gesture.id : null;
    const placed = (id: string, position: Vector3): Vector3 => dragging === id && dragPosition ? dragPosition : settled?.id === id ? settled.position : position;
    for (const [id, entry] of figures) if (!scene.figures.some(item => item.id === id)) { world.remove(entry.mannequin.group); figures.delete(id); }
    for (const figure of scene.figures) {
      let entry = figures.get(figure.id);
      if (!entry) {
        entry = {mannequin: createMannequin(mannequinGeometry, {body: bodyMaterial, joint: jointMaterial}), pose: ''};
        entry.mannequin.group.userData.previsId = figure.id;
        figures.set(figure.id, entry); world.add(entry.mannequin.group);
      }
      const heldProp = figure.held ? scene.props.find(item => item.id === figure.held!.propId) : undefined;
      const pose = `${figure.pose}:${heldProp?.kind ?? ''}:${figure.held?.hand ?? ''}`;
      if (pose !== entry.pose) { entry.mannequin.setPose(figure.pose, heldProp && figure.held ? {kind: heldProp.kind, hand: figure.held.hand} : null); entry.pose = pose; }
      const position = placed(figure.id, figure.position);
      entry.mannequin.group.position.set(position[0], position[1], position[2]);
      entry.mannequin.group.rotation.set(0, radians(figure.rotation), 0);
      entry.mannequin.group.visible = figure.visible;
      entry.mannequin.group.updateMatrixWorld(true);
    }
    for (const [id, entry] of props) if (!scene.props.some(item => item.id === id)) { world.remove(entry.group); disposePrevisObject(entry.group); props.delete(id); }
    const grip = new THREE.Vector3(), offset = new THREE.Vector3();
    for (const prop of scene.props) {
      const shape = `${prop.kind}:${prop.size.join(',')}`;
      let entry = props.get(prop.id);
      if (!entry || entry.shape !== shape) {
        if (entry) { world.remove(entry.group); disposePrevisObject(entry.group); }
        entry = {group: createPrevisPropObject(prop.kind, prop.size, propMaterials), shape};
        entry.group.userData.previsId = prop.id;
        props.set(prop.id, entry); world.add(entry.group);
      }
      const holder = heldBy(scene, prop.id), mannequin = holder ? figures.get(holder.id)?.mannequin : undefined;
      if (holder?.held && mannequin) {
        mannequin.grips[holder.held.hand].getWorldPosition(grip);
        offset.set(...previsHeldOffset(prop.kind, prop.size)).applyAxisAngle(THREE.Object3D.DEFAULT_UP, radians(holder.rotation));
        entry.group.position.copy(grip).add(offset);
        entry.group.rotation.set(0, radians(holder.rotation), 0);
        entry.group.visible = prop.visible && holder.visible;
      } else {
        const position = placed(prop.id, prop.position);
        entry.group.position.set(position[0], position[1], position[2]);
        entry.group.rotation.set(0, radians(prop.rotation), 0);
        entry.group.visible = prop.visible;
      }
    }
    const light = scene.light, center = previsSceneCenter(scene), direction = previsLightDirection(light.azimuth, light.elevation);
    key.visible = light.visible && light.intensity > 0;
    key.intensity = light.intensity * KEY_LIGHT;
    key.target.position.set(center[0], 0, center[2]);
    key.position.set(center[0] + direction[0] * 12, direction[1] * 12, center[2] + direction[2] * 12);
    key.target.updateMatrixWorld();
  }
  // ---- Overlay placement ----
  const projected = new THREE.Vector3();
  function screen(point: Vector3, width: number, height: number): {x: number; y: number} | null {
    projected.set(point[0], point[1], point[2]).project(camera);
    if (projected.z < -1 || projected.z > 1) return null;
    return {x: (projected.x + 1) / 2 * width, y: (1 - projected.y) / 2 * height};
  }
  function lightSpot(width: number, height: number): {x: number; y: number} | null {
    const scene = input!.scene;
    if (!scene.light.visible) return null;
    const center = previsSceneCenter(scene), direction = previsLightDirection(scene.light.azimuth, scene.light.elevation);
    for (const distance of [3, 2.2, 1.6, 1.1, 0.7]) {
      const spot = screen([center[0] + direction[0] * distance, center[1] + direction[1] * distance, center[2] + direction[2] * distance], width, height);
      if (spot && spot.x >= 32 && spot.x <= width - 96 && spot.y >= 112 && spot.y <= height - 72) return spot;
    }
    return null;
  }
  function anchor(id: string): Vector3 | null {
    const scene = input!.scene;
    if (id === 'light-target') return scene.light.visible ? previsSceneCenter(scene) : null;
    const figure = scene.figures.find(item => item.id === id);
    if (figure) { if (!figure.visible) return null; const value = figures.get(id)?.mannequin.group.position; return value ? [value.x, value.y, value.z] : null; }
    const prop = scene.props.find(item => item.id === id);
    if (!prop || !prop.visible || heldBy(scene, id)) return null;
    const value = props.get(id)?.group.position;
    return value ? [value.x, value.y + (prop.kind === 'sphere' ? prop.size[0] : prop.size[1]), value.z] : null;
  }
  const bounds = new THREE.Box3(), corner = new THREE.Vector3();
  function layout(): void {
    if (!input) return;
    const {width, height} = size();
    const placed: Record<string, {x: number; y: number} | null> = {};
    for (const element of overlay.querySelectorAll<HTMLElement>('[data-previs-anchor]')) {
      const id = element.dataset.previsAnchor!, point = id === PREVIS_LIGHT_SELECTION ? null : anchor(id);
      const spot = id === PREVIS_LIGHT_SELECTION ? lightSpot(width, height) : point ? screen(point, width, height) : null;
      placed[id] = spot;
      element.hidden = !spot;
      if (spot) element.style.transform = `translate(${spot.x.toFixed(1)}px, ${spot.y.toFixed(1)}px)`;
    }
    const line = overlay.querySelector<SVGLineElement>('[data-previs-light-line]');
    if (line) {
      const from = placed[PREVIS_LIGHT_SELECTION] ?? null, target = anchor('light-target'), to = target ? screen(target, width, height) : null;
      line.style.display = from && to ? '' : 'none';
      if (from && to) { line.setAttribute('x1', from.x.toFixed(1)); line.setAttribute('y1', from.y.toFixed(1)); line.setAttribute('x2', to.x.toFixed(1)); line.setAttribute('y2', to.y.toFixed(1)); }
    }
    const box = overlay.querySelector<HTMLElement>('[data-previs-selection]');
    if (box) {
      const selected = input.selection ? figures.get(input.selection)?.mannequin.group ?? props.get(input.selection)?.group : undefined;
      let rect: {left: number; top: number; right: number; bottom: number} | null = null;
      if (selected?.visible) {
        bounds.setFromObject(selected);
        for (let index = 0; index < 8 && !bounds.isEmpty(); index++) {
          corner.set(index & 1 ? bounds.max.x : bounds.min.x, index & 2 ? bounds.max.y : bounds.min.y, index & 4 ? bounds.max.z : bounds.min.z).project(camera);
          if (corner.z < -1 || corner.z > 1) { rect = null; break; }
          const x = (corner.x + 1) / 2 * width, y = (1 - corner.y) / 2 * height;
          rect = rect ? {left: Math.min(rect.left, x), top: Math.min(rect.top, y), right: Math.max(rect.right, x), bottom: Math.max(rect.bottom, y)} : {left: x, top: y, right: x, bottom: y};
        }
      }
      box.hidden = !rect;
      if (rect) Object.assign(box.style, {left: `${(rect.left - 6).toFixed(1)}px`, top: `${(rect.top - 6).toFixed(1)}px`, width: `${(rect.right - rect.left + 12).toFixed(1)}px`, height: `${(rect.bottom - rect.top + 12).toFixed(1)}px`});
    }
  }
  function render(): void {
    if (disposed || lost || !input || !live) return;
    applyCamera();
    renderer.render(world, camera);
    layout();
  }
  const invalidate = (): void => { if (!frame && !disposed) frame = requestAnimationFrame(() => { frame = 0; render(); }); };

  // ---- Reporting ----
  function emitCamera(final: boolean): void {
    if (!live) return;
    if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
    const now = performance.now();
    if (final || now - emittedAt >= EMIT_MS) { emittedAt = now; events.camera(normalizePrevisCamera(live), final); return; }
    emitTimer = setTimeout(() => { emitTimer = null; emittedAt = performance.now(); if (live) events.camera(normalizePrevisCamera(live), false); }, EMIT_MS);
  }
  function emitMove(id: string, final: boolean): void {
    if (!dragPosition) return;
    if (moveTimer) { clearTimeout(moveTimer); moveTimer = null; }
    const position = dragPosition, now = performance.now();
    if (final || now - movedAt >= EMIT_MS) { movedAt = now; events.move(id, position, final); return; }
    moveTimer = setTimeout(() => { moveTimer = null; movedAt = performance.now(); events.move(id, position, false); }, EMIT_MS);
  }

  // ---- Pointer ----
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), hit = new THREE.Vector3();
  function ray(event: PointerEvent | WheelEvent): void {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / Math.max(1, rect.width) * 2 - 1, -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  }
  function pick(): string | null {
    const targets = [...[...figures.values()].map(entry => entry.mannequin.group), ...[...props.values()].map(entry => entry.group)].filter(item => item.visible);
    for (const intersection of raycaster.intersectObjects(targets, true)) {
      for (let object: THREE.Object3D | null = intersection.object; object; object = object.parent) if (typeof object.userData.previsId === 'string') return object.userData.previsId as string;
    }
    return null;
  }
  function onPointerDown(event: PointerEvent): void {
    if (!input || !live || gesture) return;
    host.focus({preventScroll: true});
    ray(event);
    const scene = input.scene;
    if (event.button === 0) {
      const id = pick();
      if (id) {
        events.select(id);
        const holder = heldBy(scene, id), target = holder?.id ?? id;
        const element = scene.figures.find(item => item.id === target) ?? scene.props.find(item => item.id === target);
        if (!input.readOnly && element) {
          const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -element.position[1]);
          if (raycaster.ray.intersectPlane(plane, hit)) {
            gesture = {kind: 'drag', id: target, pointerId: event.pointerId, plane, offset: new THREE.Vector3(element.position[0] - hit.x, 0, element.position[2] - hit.z), moved: false, x: event.clientX, y: event.clientY};
            dragPosition = [...element.position] as Vector3;
          }
        }
      } else gesture = {kind: input.mode === 'orbit' ? 'orbit' : 'look', pointerId: event.pointerId, pivot: previsOrbitPivot(scene, input.selection), moved: false, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, empty: true};
    } else if (event.button === 1 || event.button === 2) gesture = {kind: 'pan', pointerId: event.pointerId, pivot: previsOrbitPivot(scene, input.selection), moved: false, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, empty: false};
    if (gesture) { canvas.setPointerCapture?.(event.pointerId); event.preventDefault(); }
  }
  function onPointerMove(event: PointerEvent): void {
    if (!gesture || event.pointerId !== gesture.pointerId || !input || !live) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    gesture.x = event.clientX; gesture.y = event.clientY;
    if (gesture.kind === 'drag') {
      ray(event);
      if (!raycaster.ray.intersectPlane(gesture.plane, hit)) return;
      const y = dragPosition?.[1] ?? 0;
      dragPosition = [clampCoordinate(hit.x + gesture.offset.x), y, clampCoordinate(hit.z + gesture.offset.z)];
      gesture.moved = true;
      sync(); invalidate(); emitMove(gesture.id, false);
      return;
    }
    if (!gesture.moved && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 3) return;
    gesture.moved = true;
    if (gesture.kind === 'orbit') live = orbitPrevisCamera(live, gesture.pivot, -dx * 0.3, -dy * 0.3);
    else if (gesture.kind === 'look') live = turnPrevisCamera(live, -dx * 0.15, -dy * 0.15);
    else {
      const [x, y, z] = live.position, distance = Math.min(30, Math.max(1, Math.hypot(x - gesture.pivot[0], y - gesture.pivot[1], z - gesture.pivot[2])));
      const step = distance * 0.0016, yaw = radians(live.yaw);
      live = normalizePrevisCamera({...live, position: [x - Math.cos(yaw) * dx * step, y + dy * step, z + Math.sin(yaw) * dx * step]});
    }
    invalidate(); emitCamera(false);
  }
  function onPointerUp(event: PointerEvent): void {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const ended = gesture;
    gesture = null;
    canvas.releasePointerCapture?.(event.pointerId);
    if (ended.kind === 'drag') {
      if (ended.moved && dragPosition) { settled = {id: ended.id, position: dragPosition}; emitMove(ended.id, true); }
      dragPosition = null; sync(); invalidate(); return;
    }
    if (ended.moved) emitCamera(true);
    else if (ended.empty) events.select(null);
  }
  function onWheel(event: WheelEvent): void {
    if (!live) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0012));
    live = normalizePrevisCamera({...live, focalLength: live.focalLength * factor});
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { wheelTimer = null; emitCamera(true); }, 250);
    invalidate(); emitCamera(false);
  }
  // ---- Keyboard: WASD walks, Space rises, Shift sinks ----
  function walk(time: number): void {
    walking = 0;
    if (disposed || !live || !keys.size) return;
    const seconds = Math.min(0.1, Math.max(0, (time - walkedAt) / 1000)), step = WALK_SPEED * seconds;
    walkedAt = time;
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0), right = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const up = (keys.has('Space') ? 1 : 0) - (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0);
    if (forward || right || up) { live = walkPrevisCamera(live, forward * step, right * step, up * step); render(); emitCamera(false); }
    walking = requestAnimationFrame(walk);
  }
  const typing = (target: EventTarget | null): boolean => target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
  function onKeyDown(event: KeyboardEvent): void {
    if (!MOVEMENT.has(event.code) || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
    event.preventDefault();
    if (!keys.size) { walkedAt = performance.now(); }
    keys.add(event.code);
    if (!walking) walking = requestAnimationFrame(walk);
  }
  function release(code?: string): void {
    const had = keys.size > 0;
    if (code) keys.delete(code); else keys.clear();
    if (had && !keys.size) { if (walking) { cancelAnimationFrame(walking); walking = 0; } emitCamera(true); }
  }
  const onKeyUp = (event: KeyboardEvent): void => { if (MOVEMENT.has(event.code)) release(event.code); };
  const onBlur = (): void => release();
  const onContextMenu = (event: Event): void => event.preventDefault();
  const onLost = (event: Event): void => { event.preventDefault(); lost = true; events.lost?.(true); };
  const onRestored = (): void => { lost = false; events.lost?.(false); for (const entry of figures.values()) entry.pose = ''; invalidate(); };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, {passive: false});
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('keyup', onKeyUp);
  host.addEventListener('blur', onBlur);
  const resize = new ResizeObserver(() => { const {width, height} = size(); renderer.setSize(width, height, false); render(); });
  resize.observe(host);
  { const {width, height} = size(); renderer.setSize(width, height, false); }

  return {
    update(next) {
      input = next; settled = null;
      if (!live || !cameraBusy()) live = next.scene.camera;
      sync(); invalidate();
    },
    async capture(maxEdge, maxBytes, region = 'frame') {
      if (disposed || lost || !input || !live || cameraBusy() || gesture) return null;
      const {width, height} = size(), ratio = renderer.getPixelRatio();
      const aspect = region === 'wide' ? 16 / 9 : input.aspect;
      const rect = region === 'wide' ? (() => { const w = Math.min(width, height * aspect), h = w / aspect; return {left: (width - w) / 2, top: (height - h) / 2, width: w, height: h}; })() : previsFrameRect(width, height, aspect);
      const outWidth = aspect >= 1 ? maxEdge : Math.max(1, Math.round(maxEdge * aspect));
      const outHeight = aspect >= 1 ? Math.max(1, Math.round(maxEdge / aspect)) : maxEdge;
      render();
      const target = document.createElement('canvas');
      target.width = outWidth; target.height = outHeight;
      const context = target.getContext('2d');
      if (!context) return null;
      context.imageSmoothingQuality = 'high';
      context.drawImage(canvas, rect.left * ratio, rect.top * ratio, rect.width * ratio, rect.height * ratio, 0, 0, outWidth, outHeight);
      for (const quality of [0.85, 0.7, 0.5]) {
        const blob = await new Promise<Blob | null>(resolve => target.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= maxBytes) return {dataBase64: await blobBase64(blob), width: outWidth, height: outHeight};
      }
      return null;
    },
    busy: () => Boolean(gesture) || keys.size > 0 || wheelTimer !== null,
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      if (walking) cancelAnimationFrame(walking);
      for (const timer of [wheelTimer, emitTimer, moveTimer]) if (timer) clearTimeout(timer);
      resize.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      host.removeEventListener('keydown', onKeyDown);
      host.removeEventListener('keyup', onKeyUp);
      host.removeEventListener('blur', onBlur);
      for (const entry of props.values()) disposePrevisObject(entry.group);
      for (const geometry of Object.values(mannequinGeometry)) geometry.dispose();
      for (const material of [bodyMaterial, jointMaterial, floorMaterial, ...Object.values(propMaterials)]) material.dispose();
      floorGeometry.dispose(); grid.geometry.dispose(); (grid.material as THREE.Material).dispose();
      // Browsers keep only a few WebGL contexts; release this one now rather than at garbage collection.
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
