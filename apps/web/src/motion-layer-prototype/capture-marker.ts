// 6 prefix bits, followed by the requested frame and request ordinal as 53-bit integers.
export const motionCaptureMarkerCellSize = 2;
const columns = 16;
const rows = 7;
export const motionCaptureMarkerWidth = columns * motionCaptureMarkerCellSize;
export const motionCaptureMarkerHeight = rows * motionCaptureMarkerCellSize;

export function motionCaptureMarkerBits(frame: number, request: number): string {
  return '101011' + frame.toString(2).padStart(53, '0') + request.toString(2).padStart(53, '0');
}

export function motionCaptureMarkerCell(index: number): {x: number; y: number} {
  return {
    x: index % columns * motionCaptureMarkerCellSize,
    y: Math.floor(index / columns) * motionCaptureMarkerCellSize,
  };
}
