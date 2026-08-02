import { resolve } from 'node:path'

export const POL53_PHONE_AUTH_CONTRACT_COMMIT = '6e6455a'

export function getPol53SourceCandidates(
  rootDirectory: string,
  configuredWorktree: string | undefined,
): string[] {
  const configured = configuredWorktree?.trim()
  if (configured) return [resolve(configured)]

  return [
    resolve(rootDirectory, '../../../../polo-admin-dir/dev'),
    resolve(rootDirectory, '../../../../polo-admin-dir/main'),
  ]
}
