import {schemas as modelSchemas, descriptions as modelDescriptions} from './index.ts';
import {assetMediaPublicSchemas, assetMediaDescriptions} from './asset-media.ts';
import {s1PublicOperationSchemas, s1PublicOperationDescriptions} from './asset-generation.ts';

/** Authoritative public discovery registry shared by CLI and MCP. The fixed
 * Mio catalog keeps using the core registry; public asset extensions never
 * add model tools or change their reviewed input schemas. */
export const publicOperationSchemas = {...modelSchemas, ...assetMediaPublicSchemas, ...s1PublicOperationSchemas};
export const publicOperationDescriptions = {...modelDescriptions, ...assetMediaDescriptions, ...s1PublicOperationDescriptions};
