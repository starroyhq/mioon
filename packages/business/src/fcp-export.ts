import path from 'node:path';
import {FCP_EXPORT_TASK_KIND} from '../../contracts/src/fcp-export.ts';
import type {FcpExportPreviewOutput} from '../../contracts/src/fcp-export.ts';
import {createEditorExportServices} from './editor-export.ts';
import type {EditorExportOptions, EditorExportTarget} from './editor-export.ts';
import {planEditorExport} from './fcp-export-plan.ts';
import {serializeFcpXml} from './fcp-xml.ts';
import type {ProjectStore} from './project-file/store.ts';

const target: EditorExportTarget<FcpExportPreviewOutput> = {
  kind: FCP_EXPORT_TASK_KIND,
  appName: 'Final Cut Pro',
  operationPrefix: 'fcpxml',
  nameExtension: /\.fcpxmld$/iu,
  bundleName: (title, numberSuffix) => title + numberSuffix + '.fcpxmld',
  matchesBundleName: name => path.extname(name) === '.fcpxmld',
  xmlName: () => 'Info.fcpxml',
  manifestFormat: {fcpxmlVersion: '1.13'},
  plan: input => planEditorExport(input, 'fcpxml'),
  serialize: serializeFcpXml,
};

export function createFcpExportServices(store: ProjectStore, options: EditorExportOptions) {
  return createEditorExportServices(store, options, target);
}
