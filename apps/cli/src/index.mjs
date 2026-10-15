#!/usr/bin/env node
import {open} from 'node:fs/promises';
import path from 'node:path';
import {createClient, workspaceOriginOptions, discoverSchema, schemas, ClientError, errorEnvelope, errorExitCode, successEnvelope, VERSION, EXIT_CODES} from '@mioon/client';
import {downloadAsset} from '@mioon/client/download';
import {importLutFile, LutImportFileError} from './lut-import-file.ts';

import {translate, message} from '@mioon/i18n';
import {localizeHelp} from '@mioon/i18n/presentation';

import {argumentsFor} from './arguments.ts';
import {help} from './help.ts';

let locale;
const displayErrors = new WeakMap();
const MAX_INPUT = 42 * 1024 * 1024, MAX_ASSET = 30 * 1024 * 1024;
const fail = (text, key, params) => { const error = new ClientError('VALIDATION_ERROR', text); if (key) displayErrors.set(error, message(key, params)); throw error; };
async function inputFor(options) {
  if (options.input !== undefined && options['input-file'] !== undefined) fail('Use one input source: --input or --input-file.');
  let text = options.input;
  if (options['input-file'] !== undefined) {
    let handle;
    try {
      handle = await open(options['input-file'], 'r'); const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_INPUT) throw new ClientError('FILE_TOO_LARGE', 'Input must be a regular JSON file no larger than 42 MiB.');
      text = await handle.readFile('utf8');
    } catch (error) { if (error instanceof ClientError) throw error; throw new ClientError('FILE_READ_ERROR', 'Cannot read the explicitly requested JSON input file.'); }
    finally { await handle?.close(); }
  } else if (text === '-') {
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) { length += chunk.length; if (length > MAX_INPUT) throw new ClientError('FILE_TOO_LARGE', 'JSON input exceeds 42 MiB.'); chunks.push(chunk); }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (text !== undefined && Buffer.byteLength(text) > MAX_INPUT) throw new ClientError('FILE_TOO_LARGE', 'JSON input exceeds 42 MiB.');
  let input = {};
  if (text !== undefined) { try { input = JSON.parse(text); } catch { throw new ClientError('INVALID_JSON', 'Input must contain valid JSON.'); } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Input must be a JSON object.');
  if (options['request-id'] !== undefined) {
    if (input.requestId !== undefined && input.requestId !== options['request-id']) fail('--request-id must match the requestId already present in JSON.');
    input.requestId = options['request-id'];
  }
  return input;
}
function numberOption(options, key, fallback) {
  if (options[key] === undefined) return fallback;
  if (!/^\d+$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) fail(`--${key} must be a positive integer.`);
  return Number(options[key]);
}
async function importFile(input, file) {
  if (input.dataBase64 !== undefined) fail('Use --file or dataBase64, not both.');
  let handle;
  try {
    handle = await open(file, 'r'); const metadata = await handle.stat();
    if (!metadata.isFile()) throw new ClientError('FILE_READ_ERROR', 'Import source must be a regular local file.');
    if (metadata.size > MAX_ASSET) throw new ClientError('FILE_TOO_LARGE', 'Import source exceeds 30 MiB.');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_ASSET) throw new ClientError('FILE_TOO_LARGE', 'Import source exceeds 30 MiB.');
    const extension = path.extname(file).toLowerCase();
    const mime = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4'}[extension];
    return {...input, name: input.name || path.basename(file), mimeType: input.mimeType || mime, dataBase64: bytes.toString('base64')};
  } catch (error) { if (error instanceof ClientError) throw error; throw new ClientError('FILE_READ_ERROR', 'Cannot read the explicitly requested local import file.'); }
  finally { await handle?.close(); }
}
const abort = new AbortController();
const onInterrupt = () => abort.abort();
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);
try {
  const {words, options} = argumentsFor(process.argv.slice(2), fail, value => { locale = value; });
  const invocation = Object.freeze(workspaceOriginOptions(options['workspace-origin']));
  let operation = words[0] === 'rpc' ? words.slice(1).join('.') : words.join('.');
  let data;
  if (options.version) data = {name: 'mioon', version: VERSION};
  else if (options.help || words.length === 0) data = localizeHelp(help(Object.hasOwn(schemas, operation) ? operation : undefined, {VERSION, EXIT_CODES, discoverSchema, schemas}), locale);
  else {
    let input = await inputFor(options);
    const client = createClient();
    const watch = ['job.watch', 'export.watch'].includes(operation), download = ['asset.download', 'export.download'].includes(operation);
    if (options.file !== undefined && !['asset.import', 'lut.import'].includes(operation)) fail('--file is only valid for asset or LUT import.');
    if (options.output !== undefined && !download) fail('--output is only valid for asset/export download.');
    if (options['max-bytes'] !== undefined && !download) fail('--max-bytes is only valid for download.');
    if (options['interval-ms'] !== undefined && !watch) fail('--interval-ms is only valid for watch.');
    if (options['timeout-ms'] !== undefined && !watch && !download) fail('--timeout-ms is only valid for watch or download.');
    if (words[0] === 'schema') {
      if (Object.keys(input).length) fail('schema takes an optional operation argument, not JSON input.');
      const selected = words.slice(1).join('.'); data = discoverSchema(selected ? {operation: selected} : {});
    } else if (operation === 'doctor' || operation === 'capabilities') {
      if (Object.keys(input).length) fail(`${operation} does not accept input fields.`);
      data = await client[operation]({signal: abort.signal, ...invocation});
    } else if (watch) {
      let previous;
      data = await client.watch(operation.split('.')[0], input, {timeoutMs: numberOption(options, 'timeout-ms', 60_000), intervalMs: numberOption(options, 'interval-ms', 500), signal: abort.signal, onProgress: progress => {
        const current = JSON.stringify(progress);
        if (previous !== current) { process.stderr.write(current + '\n'); previous = current; }
      }});
    } else if (download) {
      let assetId = input.assetId;
      if (operation === 'export.download') {
        const exported = await client.rpc('export.get', input, {signal: abort.signal, ...invocation});
        if (exported.status !== 'succeeded' || !exported.assetId) throw new ClientError('EXPORT_NOT_READY', 'Export is not ready. Use export watch before downloading.', {details: {exportId: exported.id, status: exported.status}});
        assetId = exported.assetId;
      } else if (Object.keys(input).some(key => key !== 'assetId')) fail('asset download only accepts assetId.');
      data = await downloadAsset({assetId}, options.output, {signal: abort.signal, timeoutMs: numberOption(options, 'timeout-ms', 60_000), maxBytes: numberOption(options, 'max-bytes', 512 * 1024 * 1024)});
    } else {
      if (!Object.hasOwn(schemas, operation)) throw new ClientError('UNKNOWN_OPERATION', 'Unknown command. Run --help or schema for available operations.');
      if (options.file !== undefined) {
        if (operation === 'lut.import') {
          try { input = importLutFile(input, options.file); }
          catch (error) {
            if (error instanceof LutImportFileError) throw new ClientError(error.code, error.message);
            throw error;
          }
        } else input = await importFile(input, options.file);
      }
      data = await client.rpc(operation, input, {signal: abort.signal, ...invocation});
    }
  }
  process.stdout.write(JSON.stringify(successEnvelope(data)) + '\n');
} catch (error) {
  const result = errorEnvelope(error);
  process.stdout.write(JSON.stringify(result) + '\n');
  const diagnostic = result.error.message.replace(/[\r\n\x00-\x1f]/g, ' ');
  const display = displayErrors.get(error);
  const human = locale === undefined ? diagnostic : display
    ? translate(locale, display.key, display.params)
    : `${translate(locale, result.error.code === 'CONNECTION_CONFIG_ERROR' ? 'cli.error.connection' : 'cli.error.summary')} ${translate(locale, 'cli.error.original', {diagnostic})}`;
  process.stderr.write(`${result.error.code}: ${human}\n`);
  process.exitCode = errorExitCode(error);
} finally {
  process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt);
}
