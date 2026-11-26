import {PREMIERE_EXPORT_TASK_KIND} from '../../contracts/src/premiere-export.ts';
import type {PremiereExportPreviewOutput} from '../../contracts/src/premiere-export.ts';
import {createEditorExportServices} from './editor-export.ts';
import type {EditorExportOptions, EditorExportTarget} from './editor-export.ts';
import {planEditorExport} from './fcp-export-plan.ts';
import {PREMIERE_XMEML_VERSION, serializePremiereXml} from './premiere-xml.ts';
import type {ProjectStore} from './project-file/store.ts';

const target: EditorExportTarget<PremiereExportPreviewOutput> = {
  kind: PREMIERE_EXPORT_TASK_KIND,
  appName: 'Premiere Pro',
  operationPrefix: 'premiere',
  nameExtension: /\.xml$/iu,
  bundleName: (title, numberSuffix) => title + ' Premiere' + numberSuffix,
  matchesBundleName: name => / Premiere(?: (?:[2-9]|[1-9][0-9]+))?$/u.test(name),
  xmlName: title => title + '.xml',
  manifestFormat: {xmemlVersion: PREMIERE_XMEML_VERSION},
  plan: input => planEditorExport(input, 'premiere'),
  serialize: serializePremiereXml,
};

export function createPremiereExportServices(store: ProjectStore, options: EditorExportOptions) {
  return createEditorExportServices(store, options, target);
}
