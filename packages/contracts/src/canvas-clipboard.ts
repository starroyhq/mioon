export const CANVAS_CLIPBOARD_HANDLE_MIME = 'application/x-mioon-canvas-handle';
const HANDLE_SIZE = 36;
const HANDLE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export const canvasClipboardHandle = (value: unknown): string | null =>
  typeof value === 'string' && value.length === HANDLE_SIZE && HANDLE.test(value) ? value : null;
