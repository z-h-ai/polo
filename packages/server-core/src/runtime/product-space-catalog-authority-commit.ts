/**
 * ProductSpace Catalog authority — INTERNAL fresh-Catalog COMMIT entry.
 *
 * NOT exposed through the package `exports` map (see packages/server-core/package.json):
 * this module is reachable only from inside `@polo-ai/server-core` source,
 * and the only production caller is the Admin handler's
 * `productSpace.CATALOG` commit zone, which persists entries that came from
 * a schema-validated, latest-wins-CAS Admin Catalog response. Any other
 * import path is package-internal by construction and the boundary is
 * asserted by `product-space-catalog-authority.test.ts`.
 */
export { recordProductSpaceCatalogAuthoritativeEntries } from './product-space-catalog-authority-internal'
