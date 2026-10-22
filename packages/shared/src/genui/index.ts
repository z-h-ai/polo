/**
 * GenUI ecosystem (POO-104): component catalog runtime registry, component
 * bundle format, and the session-app publish-chain packaging.
 */

export {
  GenUiComponentCatalog,
  createBuiltinGenUiComponentCatalog,
  getGenUiComponentCatalog,
  __resetGenUiComponentCatalogForTests,
  canonicalGenUiJson,
  computeGenUiSchemaHash,
  validateGenUiComponentBundle,
  GENUI_BUILTIN_COMPONENT_VERSION,
} from './component-catalog.ts'
export type {
  GenUiComponentRegistration,
  GenUiComponentSource,
  GenUiComponentLoaderKind,
  GenUiComponentManifest,
  GenUiComponentBundle,
  GenUiCatalogComponentLoader,
} from './component-catalog.ts'

export {
  GENUI_APP_PUBLISH_ENTRIES,
  GENUI_APP_PUBLISH_REQUIRED_ENTRY,
  collectGenUiAppPublishFiles,
  buildGenUiAppArtifactZip,
  evaluateGenUiAppPublishPolicy,
  buildGenUiPublishNotice,
  GENUI_PUBLISH_SDK_BRIDGE_NOTICE,
  GENUI_CATALOG_READ_ONLY_NOTICE,
} from './app-publish.ts'
export type {
  GenUiAppPublishFile,
  GenUiAppPublishCollection,
  GenUiAppPublishPolicyVerdict,
} from './app-publish.ts'
