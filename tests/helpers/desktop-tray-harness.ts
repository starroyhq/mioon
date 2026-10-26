import { EventEmitter } from 'node:events';
import type { TrayMenuItem } from '../../apps/desktop/src/tray-host.ts';

/** Only the OS image/menu surface is synthetic; callers run the real tray host. */
export function desktopTrayHarness() {
  const paths: string[] = [], images: Image[] = [], trays: Tray[] = [];
  class Image {
    template = false;
    isEmpty() { return false; }
    setTemplateImage(value: boolean) { this.template = value; }
  }
  class Tray extends EventEmitter {
    destroyed = false; destroys = 0; tooltip = ''; menu: TrayMenuItem[] = [];
    readonly image: Image;
    constructor(image: Image) { super(); this.image = image; trays.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.destroys++; }
    setToolTip(value: string) { this.tooltip = value; }
    setContextMenu(value: TrayMenuItem[]) { this.menu = value; }
  }
  const nativeImage = {createFromPath(file: string) { paths.push(file); const image = new Image(); images.push(image); return image; }};
  return {Tray, nativeImage, paths, images, trays};
}
