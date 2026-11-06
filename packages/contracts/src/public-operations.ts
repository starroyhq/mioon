import {schemas as modelSchemas, descriptions as modelDescriptions} from './index.ts';
import {assetMediaPublicSchemas, assetMediaDescriptions} from './asset-media.ts';
import {s1PublicOperationSchemas, s1PublicOperationDescriptions} from './asset-generation.ts';
import {previsPublicationSchemas, previsPublicationDescriptions} from './previs-publication.ts';

/** Authoritative public discovery registry shared by CLI and MCP. The fixed
 * Mio catalog keeps using the core registry; public asset extensions never
 * add model tools or change their reviewed input schemas. */
// Retain the core definition only for frozen model diagnostics and historical
// request decoding. Public discovery must not advertise the retired writer.
const {'project.notes.set': _retiredNotesSchema, ...currentModelSchemas} = modelSchemas;
const {'project.notes.set': _retiredNotesDescription, ...currentModelDescriptions} = modelDescriptions;
export const publicOperationSchemas = {...currentModelSchemas, ...assetMediaPublicSchemas, ...s1PublicOperationSchemas, ...previsPublicationSchemas};
export const publicOperationDescriptions = {...currentModelDescriptions, ...assetMediaDescriptions, ...s1PublicOperationDescriptions, ...previsPublicationDescriptions};
