/**
 * ProductSpace Catalog authority — PUBLIC surface (POO-43).
 *
 * Read, revoke and test-observability ONLY. The grant-capable fresh-Catalog
 * commit mutator deliberately lives in
 * `./product-space-catalog-authority-commit.ts`, which is NOT exposed through
 * the package `exports` map: the only caller able to mint process trust is
 * the Admin Catalog handler's schema-validated commit path. A public importer
 * can neither fabricate raw entries into trust nor overwrite the committer.
 *
 * Cold-start model: the persisted file is a recovery/display CANDIDATE — it
 * grants nothing. A scope becomes trusted in THIS process only via a fresh
 * server revalidation performed by the internal commit path.
 */
export {
  hasProductSpaceCatalogAuthorityTuple,
  loadProductSpaceCatalogAuthorityTupleSet,
  loadProductSpaceWithdrawnTombstoneTupleSet,
  getProductSpaceCatalogAuthorityRecord,
  productSpaceCatalogAuthorityKey,
  productSpaceCatalogAuthorityTupleKey,
  revokeProductSpaceCatalogAuthority,
  resetProductSpaceCatalogAuthorityForTests,
  __dropAuthorityProcessCacheForTests,
  PRODUCT_SPACE_CATALOG_AUTHORITY_SCHEMA_VERSION,
  type ProductSpaceCatalogAuthorityEntry,
} from './product-space-catalog-authority-internal'
