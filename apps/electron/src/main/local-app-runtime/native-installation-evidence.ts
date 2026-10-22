import type { ProductSpaceAppIdentity, CatalogLocalAppScope } from '@polo-ai/shared/protocol'
import {
  admitTrustedNativeInstallation, getNativeInstallationOutbox,
  type NativeInstallationIntent, type NativeInstallationSnapshot,
} from '@polo-ai/server-core/runtime/native-installations'
import type { ScopedLocalAppRuntimeRegistry } from './scoped-registry'

const wireChecksum = (checksum: string) => `sha256:${checksum.trim().toLowerCase().replace(/^sha256:/,'')}`
function binding(app: ProductSpaceAppIdentity) {
  return {kind: 'app' as const, accountId: app.accountId, productSpaceId: app.productSpaceId, subjectId: app.artifactInstanceId}
}
export async function prepareNativeAppInstall(app: ProductSpaceAppIdentity, spaceKind: 'personal'|'enterprise', checksum: string) {
  const admission = await admitTrustedNativeInstallation(app.accountId, {
    contractVersion: 1, productSpaceId: app.productSpaceId,
    subjectKind: spaceKind === 'personal' ? 'personal_artifact' : 'enterprise_instance',
    subjectId: app.artifactInstanceId, versionId: app.versionId, version: app.version, checksum: wireChecksum(checksum),
  })
  return getNativeInstallationOutbox().prepare(admission,binding(app),'install')
}
export async function prepareNativeAppUninstall(app: ProductSpaceAppIdentity) {
  const outbox = getNativeInstallationOutbox(), nativeBinding = binding(app)
  const retained = await outbox.retained(nativeBinding)
  // Existing installations without a captured admission remain unknown.
  const original = retained.find(row => row.accountId === app.accountId && row.productSpaceId === app.productSpaceId && row.subjectId === app.artifactInstanceId)
  return original ? outbox.prepare(original,nativeBinding,'uninstall') : null
}
async function snapshot(registry: ScopedLocalAppRuntimeRegistry, intent: NativeInstallationIntent): Promise<NativeInstallationSnapshot|null> {
  if (intent.binding.kind !== 'app') return null
  const scope: CatalogLocalAppScope = {kind: 'catalog',accountId: intent.binding.accountId,organizationId: intent.binding.productSpaceId,catalogAppId: intent.binding.subjectId}
  const evidence = await registry.readNativeInstallationEvidence(scope)
  if (!evidence) return null
  if (evidence.presence === 'absent') return intent.action === 'uninstall' ? {state: 'uninstalled',installedAdmissionIds: [],unmappedVersionCount: 0} : null
  const retained = await getNativeInstallationOutbox().retained(intent.binding)
  const exact = evidence.versions.flatMap(row => {
    const admission = retained.find(admission => admission.admissionId === row.admissionId && admission.version === row.version && admission.checksum === wireChecksum(row.checksum)
      && admission.accountId === intent.admission.accountId && admission.productSpaceId === intent.admission.productSpaceId && admission.subjectId === intent.admission.subjectId)
    return admission ? [admission.admissionId] : []
  })
  if (intent.action === 'install' && !exact.includes(intent.admission.admissionId)) return null
  return {state: 'installed',installedAdmissionIds: [...new Set(exact)],unmappedVersionCount: evidence.versions.length-exact.length}
}
export async function finishNativeAppInstallation(registry: ScopedLocalAppRuntimeRegistry, intent: NativeInstallationIntent|null) {
  if (!intent) return
  const evidence = await snapshot(registry,intent)
  if (evidence) await getNativeInstallationOutbox().commit(intent.id,evidence)
}
export async function recoverNativeAppInstallationEvidence(registry: ScopedLocalAppRuntimeRegistry) {
  await getNativeInstallationOutbox().recover(intent => snapshot(registry,intent))
}
