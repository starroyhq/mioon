import {AppError} from '../../contracts/src/app-error.ts';

/** The existing byte-upload admission, shared by workspace fixtures and the
 * reference importer. A MIME declaration never substitutes for the header. */
export function decodeMediaUpload(dataBase64: string, mimeType: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(dataBase64) || dataBase64.length % 4) throw new AppError('INVALID_MEDIA', '无效的 base64');
  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.length > 30 * 1024 * 1024 || bytes.length === 0) throw new AppError('INVALID_MEDIA', '素材大小须为 1 字节至 30 MiB');
  const four = (start: number, value: string): boolean => bytes.toString('ascii', start, start + 4) === value;
  const mp3Frame = bytes.length >= 4 && bytes[0] === 255 && (bytes[1]! & 224) === 224 && (bytes[1]! & 24) !== 8 && (bytes[1]! & 6) !== 0 && (bytes[2]! & 240) !== 240 && (bytes[2]! & 12) !== 12;
  const detected = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' :
    four(0, 'RIFF') && four(8, 'WEBP') ? 'image/webp' : four(0, 'RIFF') && four(8, 'WAVE') ? 'audio/wav' :
    bytes.toString('ascii', 0, 3) === 'ID3' || mp3Frame ? 'audio/mpeg' : four(4, 'ftyp') ? 'iso-bmff' :
    bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163])) ? 'video/webm' : null;
  if (!(detected === 'iso-bmff' ? ['video/mp4', 'audio/mp4'].includes(mimeType) : detected === mimeType)) throw new AppError('INVALID_MEDIA', '文件类型与实际内容不符');
  return bytes;
}
