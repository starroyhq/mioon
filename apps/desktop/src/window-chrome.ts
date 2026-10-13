// macOS hides the native title bar so the workbench top bar can host the window
// controls ("traffic lights"). Other platforms keep their native frame, which
// already carries the controls. The renderer reserves matching space in
// apps/web/src/styles.css (:root[data-desktop-frame="mac-inset"]).
export const MAC_TRAFFIC_LIGHT_POSITION = Object.freeze({x: 20, y: 22});

export type WindowChromeOptions = {titleBarStyle?: 'hidden'; trafficLightPosition?: {x: number; y: number}};

export function windowChromeOptions(platform: NodeJS.Platform = process.platform): WindowChromeOptions {
  return platform === 'darwin'
    ? {titleBarStyle: 'hidden', trafficLightPosition: {...MAC_TRAFFIC_LIGHT_POSITION}}
    : {};
}
