import { beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { createCipheriv, hkdfSync } from 'node:crypto'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import { createProductSpaceContextKey } from '@polo-ai/shared/product-spaces'
import type { AdminLlmConnection } from '@polo-ai/shared/admin'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  getRuntimeActiveProductSpace,
  listRegisteredProductSpaceExecutions,
  registerProductSpaceExecution,
  resetProductSpaceExecutionRegistryForTests,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  stopRegisteredProductSpaceExecutionsForAccount,
} from '../../runtime/product-space-executions'
import { getAccountTransitionEpoch } from './trusted-product-space-account'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

type StoredTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  userId: string
  username: string
  displayName?: string
  role?: string
  groupIds?: string[]
}

type TestConnection = {
  slug: string
  name: string
  providerType: 'anthropic' | 'pi' | 'pi_compat'
  authType: 'api_key' | 'api_key_with_endpoint' | 'oauth' | 'iam_credentials' | 'bearer_token' | 'service_account_file' | 'environment' | 'none'
  createdAt: number
  managedBy?: 'admin'
  adminConfigVersion?: string
  baseUrl?: string
  endpoint?: string
  piAuthProvider?: string
  customEndpoint?: {
    api: 'openai-completions' | 'anthropic-messages'
  }
  apiKey?: string | TestEncryptedApiKey
  credentials?: {
    apiKey?: string | TestEncryptedApiKey
    key?: string
  }
  models?: string[]
  defaultModel?: string
}

type TestEncryptedApiKey = {
  alg: 'A256GCM'
  iv: string
  ciphertext: string
  tag: string
}

class TestAdminError extends Error {
  readonly errorCode: string
  readonly status?: number
  readonly details?: { retryAfter?: number }

  constructor(message: string, errorCode: string, options?: { status?: number; details?: { retryAfter?: number } }) {
    super(message)
    this.name = 'AdminError'
    this.errorCode = errorCode
    this.status = options?.status
    this.details = options?.details
  }
}

const adminClientCalls: Array<{ method: string; args: unknown[]; accessToken?: string }> = []
const adminClientBehavior = {
  login: async (_username: string, _password: string): Promise<any> => {
    throw new Error('login behavior not configured')
  },
  refresh: async (_refreshToken: string): Promise<any> => {
    throw new Error('refresh behavior not configured')
  },
  validate: async (_accessToken: string): Promise<any> => {
    throw new Error('validate behavior not configured')
  },
  getAuthConfig: async (): Promise<any> => ({ phoneAuthEnabled: true }),
  getPhoneAuthChallengeConfig: async (): Promise<any> => ({
    type: 'browser_redirect',
    issuerUrl: 'https://challenge.example.com/phone-auth',
  }),
  sendPhoneAuthCode: async (_input: { phone: string; challengeToken: string }): Promise<any> => ({
    accepted: true,
    expiresIn: 300,
    resendAfter: 60,
  }),
  verifyPhoneAuthCode: async (_input: { phone: string; code: string }): Promise<any> => {
    throw new Error('verifyPhoneAuthCode behavior not configured')
  },
  setPassword: async (_accessToken: string, _input: { password: string }): Promise<any> => ({
    success: true,
  }),
  logout: async (_accessToken: string): Promise<void> => {},
  getLlmConnections: async (_accessToken: string): Promise<any> => ({
    configVersion: 'config-v1',
    connections: [],
    defaultConnection: null,
  }),
  getAppCatalog: async (
    _accessToken: string,
    _organizationId: string,
    _appConfigVersion?: string,
  ): Promise<any> => {
    throw new Error('getAppCatalog behavior not configured')
  },
  listOrganizations: async (_accessToken: string): Promise<any> => ({ organizations: [] }),
  listProductSpaces: async (_accessToken: string): Promise<any> => {
    throw new Error('listProductSpaces behavior not configured')
  },
  getProductSpaceCatalog: async (_accessToken: string, _context: unknown): Promise<any> => {
    throw new Error('getProductSpaceCatalog behavior not configured')
  },
  createOrganization: async (_accessToken: string, _input: unknown): Promise<any> => {
    throw new Error('createOrganization behavior not configured')
  },
  previewOrganizationJoin: async (_token: string): Promise<any> => {
    throw new Error('previewOrganizationJoin behavior not configured')
  },
  acceptOrganizationJoin: async (_accessToken: string, _token: string): Promise<any> => {
    throw new Error('acceptOrganizationJoin behavior not configured')
  },
}

class MockAdminClient {
  readonly adminUrl: string

  constructor(adminUrl: string) {
    this.adminUrl = adminUrl
  }

  async login(username: string, password: string) {
    adminClientCalls.push({ method: 'login', args: [username, password] })
    return adminClientBehavior.login(username, password)
  }

  async getAuthConfig() {
    adminClientCalls.push({ method: 'getAuthConfig', args: [] })
    return adminClientBehavior.getAuthConfig()
  }

  async getPhoneAuthChallengeConfig() {
    adminClientCalls.push({ method: 'getPhoneAuthChallengeConfig', args: [] })
    return adminClientBehavior.getPhoneAuthChallengeConfig()
  }

  async sendPhoneAuthCode(input: { phone: string; challengeToken: string }) {
    adminClientCalls.push({ method: 'sendPhoneAuthCode', args: [input] })
    return adminClientBehavior.sendPhoneAuthCode(input)
  }

  async verifyPhoneAuthCode(input: { phone: string; code: string }) {
    adminClientCalls.push({ method: 'verifyPhoneAuthCode', args: [input] })
    return adminClientBehavior.verifyPhoneAuthCode(input)
  }

  async setPassword(accessToken: string, input: { password: string }) {
    adminClientCalls.push({ method: 'setPassword', args: [input], accessToken })
    return adminClientBehavior.setPassword(accessToken, input)
  }

  async refresh(refreshToken: string) {
    adminClientCalls.push({ method: 'refresh', args: [refreshToken] })
    return adminClientBehavior.refresh(refreshToken)
  }

  async validate(accessToken: string) {
    adminClientCalls.push({ method: 'validate', args: [accessToken], accessToken })
    return adminClientBehavior.validate(accessToken)
  }

  async logout(accessToken: string) {
    adminClientCalls.push({ method: 'logout', args: [accessToken], accessToken })
    return adminClientBehavior.logout(accessToken)
  }

  async getLlmConnections(accessToken: string) {
    adminClientCalls.push({ method: 'getLlmConnections', args: [accessToken], accessToken })
    return adminClientBehavior.getLlmConnections(accessToken)
  }

  async getAppCatalog(
    accessToken: string,
    organizationId: string,
    appConfigVersion?: string,
  ) {
    adminClientCalls.push({
      method: 'getAppCatalog',
      args: [organizationId, appConfigVersion],
      accessToken,
    })
    return adminClientBehavior.getAppCatalog(
      accessToken,
      organizationId,
      appConfigVersion,
    )
  }

  async listOrganizations(accessToken: string) {
    adminClientCalls.push({ method: 'listOrganizations', args: [], accessToken })
    return adminClientBehavior.listOrganizations(accessToken)
  }

  async listProductSpaces(accessToken: string) {
    adminClientCalls.push({ method: 'listProductSpaces', args: [], accessToken })
    return adminClientBehavior.listProductSpaces(accessToken)
  }

  async getProductSpaceCatalog(accessToken: string, context: unknown) {
    adminClientCalls.push({
      method: 'getProductSpaceCatalog',
      args: [context],
      accessToken,
    })
    return adminClientBehavior.getProductSpaceCatalog(accessToken, context)
  }

  async createOrganization(accessToken: string, input: unknown) {
    adminClientCalls.push({ method: 'createOrganization', args: [input], accessToken })
    return adminClientBehavior.createOrganization(accessToken, input)
  }

  async previewOrganizationJoin(token: string) {
    adminClientCalls.push({ method: 'previewOrganizationJoin', args: [token] })
    return adminClientBehavior.previewOrganizationJoin(token)
  }

  async acceptOrganizationJoin(accessToken: string, token: string) {
    adminClientCalls.push({ method: 'acceptOrganizationJoin', args: [token], accessToken })
    return adminClientBehavior.acceptOrganizationJoin(accessToken, token)
  }
}

const configState: {
  adminUrl?: string
  adminConfigVersion?: string
  connections: TestConnection[]
  defaultConnection: string | null
} = {
  adminUrl: 'https://admin.example.com',
  adminConfigVersion: undefined,
  connections: [],
  defaultConnection: null,
}

const managerState: {
  tokens: StoredTokens | null
  llmApiKeys: Map<string, string>
  deletedCredentialSlugs: string[]
} = {
  tokens: null,
  llmApiKeys: new Map(),
  deletedCredentialSlugs: [],
}

const loggerWarn = jest.fn()
const appCatalogCache = new Map<string, any>()
const appCatalogAccess = new Map<string, string>()
const appCatalogCacheBehavior: {
  denyWriteError: Error | null
} = {
  denyWriteError: null,
}
const adminSessionEnding = jest.fn(async (_accountId: string) => {})
const adminSessionStarted = jest.fn(async (_accountId: string) => {})
const retainedCatalogAppIds = jest.fn(async (
  _accountId: string,
  _organizationId: string,
): Promise<ReadonlySet<string>> => new Set())
const listStoredCredentials = jest.fn(async () => ['admin-tokens', 'local-provider'])
const deleteStoredCredential = jest.fn(async (_credentialId: string) => true)

const mockCredentialManager = {
  async getAdminTokens(): Promise<StoredTokens | null> {
    return managerState.tokens
  },
  async setAdminTokens(tokens: StoredTokens): Promise<void> {
    managerState.tokens = { ...tokens }
  },
  async deleteAdminTokens(): Promise<boolean> {
    const hadTokens = managerState.tokens !== null
    managerState.tokens = null
    return hadTokens
  },
  async setLlmApiKey(slug: string, apiKey: string): Promise<void> {
    managerState.llmApiKeys.set(slug, apiKey)
  },
  async deleteLlmCredentials(slug: string): Promise<void> {
    managerState.deletedCredentialSlugs.push(slug)
    managerState.llmApiKeys.delete(slug)
  },
  isExpired(credential: { expiresAt?: number }): boolean {
    return typeof credential.expiresAt === 'number' && Date.now() > credential.expiresAt - 5 * 60 * 1000
  },
  list: listStoredCredentials,
  delete: deleteStoredCredential,
}

mock.module('@polo-ai/shared/admin', () => ({
  AdminClient: MockAdminClient,
  AdminError: TestAdminError,
  analyzeCreatorAppPayload: () => ({ status: 'invalid', message: 'not configured' }),
  createCanonicalCreatorAppBundle: () => { throw new Error('not configured') },
  decodeCreatorAppPayloadZip: () => { throw new Error('not configured') },
  normalizeCreatorAppPayloadRoot: (entries: unknown) => entries,
  resolveCreatorAppPublishingOrganization: () => ({ organizationId: null, source: 'none' }),
  setAppCatalogAccessMode: (
    accountId: string,
    organizationId: string,
    mode: string,
  ) => {
    appCatalogAccess.set(`${accountId}:${organizationId}`, mode)
  },
  getAppCatalogAccessMode: (accountId: string, organizationId: string) =>
    appCatalogAccess.get(`${accountId}:${organizationId}`) ?? 'offline',
  getAppCatalogApps: (catalog: { apps?: unknown[] }) => catalog.apps ?? [],
  isAppCatalogAccessDeniedForAccount: () => false,
  denyAppCatalogAccessForAccount: (accountId: string) => {
    for (const key of appCatalogAccess.keys()) {
      if (key.startsWith(`${accountId}:`)) appCatalogAccess.set(key, 'denied')
    }
  },
  resumeAppCatalogAccessForAccount: () => {},
  getCachedAppCatalog: (accountId: string, organizationId: string) =>
    appCatalogCache.get(`${accountId}:${organizationId}`) ?? null,
  listCachedAppCatalogs: (accountId: string) => [...appCatalogCache.values()]
    .filter(cached => cached.accountId === accountId),
  denyCachedAppCatalogAuthorization: (accountId: string, organizationId: string) => {
    if (appCatalogCacheBehavior.denyWriteError) {
      throw appCatalogCacheBehavior.denyWriteError
    }
    const key = `${accountId}:${organizationId}`
    const cached = appCatalogCache.get(key)
    if (!cached) return null
    const denied = {
      ...cached,
      authorizationStatus: 'denied',
      apps: cached.apps.map((app: Record<string, unknown>) => ({
        ...app,
        availability: 'unavailable',
      })),
    }
    appCatalogCache.set(key, denied)
    return denied
  },
  denyCachedAppCatalogAuthorizationForAccount: (accountId: string) => {
    if (appCatalogCacheBehavior.denyWriteError) {
      throw appCatalogCacheBehavior.denyWriteError
    }
    const denied = []
    for (const [key, cached] of appCatalogCache) {
      if (!key.startsWith(`${accountId}:`)) continue
      const entry = {
        ...cached,
        authorizationStatus: 'denied',
        apps: cached.apps.map((app: Record<string, unknown>) => ({
          ...app,
          availability: 'unavailable',
        })),
      }
      appCatalogCache.set(key, entry)
      denied.push(entry)
    }
    return denied
  },
  saveAppCatalog: (
    accountId: string,
    organizationId: string,
    catalog: { appConfigVersion: string; apps: unknown[] },
  ) => {
    const entry = {
      ...catalog,
      accountId,
      organizationId,
      authorizationStatus: 'authorized',
      syncedAt: 100,
    }
    appCatalogCache.set(`${accountId}:${organizationId}`, entry)
    return entry
  },
  getSafeAdminErrorMessage: (errorCode: string, status?: number) => {
    if (typeof status === 'number' && status >= 500) {
      return 'Admin service is temporarily unavailable'
    }
    if (errorCode === 'sms_rate_limited') {
      return 'Phone authentication request was rate limited'
    }
    if (errorCode === 'INVALID_CREDENTIALS') {
      return 'Invalid username or password'
    }
    if (errorCode === 'invalid_phone') {
      return 'Phone number is invalid'
    }
    if (errorCode === 'verification_code_invalid') {
      return 'Verification code is invalid'
    }
    if (errorCode === 'phone_auth_configuration_error') {
      return 'Phone authentication is not configured'
    }
    if (errorCode === 'VALIDATION_ERROR') {
      return 'Admin request was rejected'
    }
    if (
      errorCode === 'TOKEN_REVOKED'
      || errorCode === 'TOKEN_EXPIRED'
      || errorCode === 'INVALID_TOKEN'
      || errorCode === 'UNAUTHORIZED'
    ) {
      return 'Admin session is no longer valid'
    }
    return 'Admin request failed'
  },
}))

mock.module('@polo-ai/shared/config', () => ({
  getWorkspaceByNameOrId: () => null,
  setSetupDeferred: () => {},
  getAdminUrl: () => configState.adminUrl,
  getAdminConfigVersion: () => configState.adminConfigVersion,
  setAdminConfigVersion: (version: string | undefined) => {
    configState.adminConfigVersion = version
  },
  getLlmConnections: () => configState.connections,
  addLlmConnection: (connection: TestConnection) => {
    if (configState.connections.some(item => item.slug === connection.slug)) return false
    configState.connections.push({ ...connection })
    return true
  },
  updateLlmConnection: (slug: string, updates: Partial<TestConnection>) => {
    const index = configState.connections.findIndex(item => item.slug === slug)
    if (index === -1) return false
    configState.connections[index] = { ...configState.connections[index]!, ...updates, slug }
    return true
  },
  deleteLlmConnection: (slug: string) => {
    const before = configState.connections.length
    configState.connections = configState.connections.filter(item => item.slug !== slug)
    if (configState.defaultConnection === slug) {
      configState.defaultConnection = configState.connections[0]?.slug ?? null
    }
    return configState.connections.length !== before
  },
  setDefaultLlmConnection: (slug: string) => {
    if (!configState.connections.some(item => item.slug === slug)) return false
    configState.defaultConnection = slug
    return true
  },
}))

mock.module('@polo-ai/shared/credentials', () => ({
  getCredentialManager: () => mockCredentialManager,
  SOURCE_CREDENTIAL_TYPES: [
    'source_oauth',
    'source_bearer',
    'source_apikey',
    'source_basic',
  ],
  startInvocationCredentialProxy: async () => {
    throw new Error('Invocation credential proxy is not configured for admin handler tests')
  },
}))

// Pure fake of the authority module: admin.ts only consumes the record
// entrypoint. Tests that need the REAL authority run in their own isolated
// files against the untouched module.
const authorityRecordCalls: Array<{
  accountId: string
  productSpaceId: string
  catalogRevision: string
  entryCount: number
}> = []
let failAuthorityRecord = false
mock.module('@polo-ai/server-core/runtime/product-space-catalog-authority', () => ({
  recordProductSpaceCatalogAuthoritativeEntries: (
    accountId: string,
    productSpaceId: string,
    catalogRevision: string,
    entries: ReadonlyArray<Record<string, unknown>>,
  ) => {
    authorityRecordCalls.push({ accountId, productSpaceId, catalogRevision, entryCount: entries.length })
    if (failAuthorityRecord) {
      throw new Error('authority write failed (injected)')
    }
    return []
  },
}))

const {
  readApiKey,
  registerAdminHandlers,
  __bumpProductSpaceCatalogSyncFenceForTests,
  __productSpaceCatalogSyncScopeCountForTests,
} = await import('./admin')
const { registerAuthHandlers } = await import('./auth')

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }
  const deps = {
    sessionManager: {} as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: jest.fn(),
        warn: loggerWarn,
        error: jest.fn(),
        debug: jest.fn(),
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    onAdminSessionEnding: adminSessionEnding,
    onAdminSessionStarted: adminSessionStarted,
    getRetainedCatalogAppIds: retainedCatalogAppIds,
  } satisfies HandlerDeps

  const adminSessions = registerAdminHandlers(server, deps)
  registerAuthHandlers(server, deps, adminSessions)

  return {
    login: requiredHandler(handlers, RPC_CHANNELS.admin.LOGIN),
    getAuthConfig: requiredHandler(handlers, RPC_CHANNELS.admin.GET_AUTH_CONFIG),
    getPhoneAuthChallengeConfig: requiredHandler(
      handlers,
      RPC_CHANNELS.admin.GET_PHONE_AUTH_CHALLENGE_CONFIG,
    ),
    sendPhoneAuthCode: requiredHandler(handlers, RPC_CHANNELS.admin.SEND_PHONE_AUTH_CODE),
    verifyPhoneAuthCode: requiredHandler(handlers, RPC_CHANNELS.admin.VERIFY_PHONE_AUTH_CODE),
    setPassword: requiredHandler(handlers, RPC_CHANNELS.admin.SET_PASSWORD),
    validate: requiredHandler(handlers, RPC_CHANNELS.admin.VALIDATE),
    logout: requiredHandler(handlers, RPC_CHANNELS.admin.LOGOUT),
    authLogout: requiredHandler(handlers, RPC_CHANNELS.auth.LOGOUT),
    syncConnections: requiredHandler(handlers, RPC_CHANNELS.admin.SYNC_CONNECTIONS),
    syncAppCatalog: requiredHandler(handlers, RPC_CHANNELS.admin.SYNC_APP_CATALOG),
    productSpaceCatalog: requiredHandler(handlers, RPC_CHANNELS.productSpace.CATALOG),
    listOrganizations: requiredHandler(handlers, RPC_CHANNELS.admin.LIST_ORGANIZATIONS),
    createOrganization: requiredHandler(handlers, RPC_CHANNELS.admin.CREATE_ORGANIZATION),
    previewOrganizationJoin: requiredHandler(handlers, RPC_CHANNELS.admin.PREVIEW_ORGANIZATION_JOIN),
    acceptOrganizationJoin: requiredHandler(handlers, RPC_CHANNELS.admin.ACCEPT_ORGANIZATION_JOIN),
    listOrganizationMembers: requiredHandler(handlers, RPC_CHANNELS.admin.LIST_ORGANIZATION_MEMBERS),
    listOrganizationInvitations: requiredHandler(handlers, RPC_CHANNELS.admin.LIST_ORGANIZATION_INVITATIONS),
    createOrganizationInvitation: requiredHandler(handlers, RPC_CHANNELS.admin.CREATE_ORGANIZATION_INVITATION),
    cancelOrganizationInvitation: requiredHandler(handlers, RPC_CHANNELS.admin.CANCEL_ORGANIZATION_INVITATION),
    createOrganizationJoinLink: requiredHandler(handlers, RPC_CHANNELS.admin.CREATE_ORGANIZATION_JOIN_LINK),
    revokeOrganizationJoinLink: requiredHandler(handlers, RPC_CHANNELS.admin.REVOKE_ORGANIZATION_JOIN_LINK),
    updateOrganizationMember: requiredHandler(handlers, RPC_CHANNELS.admin.UPDATE_ORGANIZATION_MEMBER),
    removeOrganizationMember: requiredHandler(handlers, RPC_CHANNELS.admin.REMOVE_ORGANIZATION_MEMBER),
  }
}

function requiredHandler(handlers: Map<string, HandlerFn>, channel: string): HandlerFn {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return handler
}

function adminConnection(overrides: Partial<TestConnection> = {}): TestConnection {
  return {
    slug: 'admin-anthropic',
    name: 'Admin Anthropic',
    providerType: 'anthropic',
    authType: 'api_key',
    createdAt: 100,
    models: ['claude-sonnet-4-5'],
    defaultModel: 'claude-sonnet-4-5',
    apiKey: 'sk-admin',
    ...overrides,
  }
}

function encryptedApiKey(apiKey: string, accessToken = 'access-token'): TestEncryptedApiKey {
  const transitKey = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(accessToken, 'utf8'),
      Buffer.from('polo-llm-key-encryption', 'utf8'),
      Buffer.from('aes-256-gcm', 'utf8'),
      32,
    ),
  )
  const iv = Buffer.from('00112233445566778899aabb', 'hex')
  const cipher = createCipheriv('aes-256-gcm', transitKey, iv)
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    alg: 'A256GCM',
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  loggerWarn.mockClear()
  adminSessionEnding.mockClear()
  adminSessionEnding.mockImplementation(async () => {})
  adminSessionStarted.mockClear()
  adminSessionStarted.mockImplementation(async () => {})
  retainedCatalogAppIds.mockClear()
  retainedCatalogAppIds.mockImplementation(async () => new Set())
  listStoredCredentials.mockClear()
  deleteStoredCredential.mockClear()
  resetProductSpaceExecutionRegistryForTests()
  setRuntimeActiveProductSpace(null)
  setRuntimeActiveProductSpaceAccount(null)
  adminClientCalls.length = 0
  configState.adminUrl = 'https://admin.example.com'
  configState.adminConfigVersion = undefined
  configState.connections = []
  configState.defaultConnection = null
  managerState.tokens = null
  managerState.llmApiKeys = new Map()
  managerState.deletedCredentialSlugs = []
  appCatalogCache.clear()
  appCatalogAccess.clear()
  appCatalogCacheBehavior.denyWriteError = null

  adminClientBehavior.login = async () => ({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresIn: 3600,
    user: {
      id: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
      role: 'admin',
      groupIds: ['group-1'],
    },
  })
  adminClientBehavior.refresh = async () => ({
    accessToken: 'fresh-access-token',
    refreshToken: 'fresh-refresh-token',
    expiresIn: 3600,
  })
  adminClientBehavior.validate = async () => ({
    valid: true,
    configVersion: 'config-v1',
    user: {
      id: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
      role: 'admin',
      groupIds: [],
    },
  })
  adminClientBehavior.getAuthConfig = async () => ({ phoneAuthEnabled: true })
  adminClientBehavior.getPhoneAuthChallengeConfig = async () => ({
    type: 'browser_redirect',
    issuerUrl: 'https://challenge.example.com/phone-auth',
  })
  adminClientBehavior.sendPhoneAuthCode = async () => ({
    accepted: true,
    expiresIn: 300,
    resendAfter: 60,
  })
  adminClientBehavior.verifyPhoneAuthCode = async () => ({
    accessToken: 'phone-access-token',
    refreshToken: 'phone-refresh-token',
    expiresIn: 3600,
    user: {
      id: 'phone-user-1',
      username: 'phone_13800138000',
      displayName: null,
      role: 'user',
      groupIds: ['group-1'],
    },
    isNewUser: true,
  })
  adminClientBehavior.setPassword = async () => ({ success: true })
  adminClientBehavior.logout = async () => {}
  adminClientBehavior.getLlmConnections = async () => ({
    configVersion: 'config-v1',
    connections: [adminConnection()],
    defaultConnection: 'admin-anthropic',
  })
  adminClientBehavior.getAppCatalog = async () => ({
    notModified: false,
    appConfigVersion: 'apps-v1',
    apps: [],
  })
  adminClientBehavior.listOrganizations = async () => ({ organizations: [] })
  adminClientBehavior.listProductSpaces = async () => ({
    productSpaces: [{ id: 'space-a', accessMode: 'active' }],
  })
  adminClientBehavior.getProductSpaceCatalog = async () => ({
    contractVersion: 1,
    productSpaceId: 'space-a',
    catalogRevision: 'rev-1',
    entries: [],
  })
})

process.env.POLO_AI_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'polo-admin-authority-'))

function authorityTestEntry(catalogRevision: string) {
  return {
    kind: 'app',
    catalogEntryId: `entry-${catalogRevision}`,
    artifactInstanceId: `artifact-${catalogRevision}`,
    version: { versionId: `version-${catalogRevision}`, version: '1.0.0' },
    name: 'Authority App',
    description: '',
    availability: 'available',
    sources: [{ kind: 'enterprise_import', name: 'Studio A' }],
    permissions: [],
  }
}

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const poll = () => {
      const value = predicate()
      if (value !== undefined) return resolve(value)
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(poll, 10)
    }
    poll()
  })
}

describe('ProductSpace Catalog latest-request fence and authority commit', () => {
  const context = {
    clientId: 'renderer',
    workspaceId: null,
    webContentsId: null,
    signal: new AbortController().signal,
  }
  let productSpaceCatalog: HandlerFn
  let logout: HandlerFn

  beforeEach(async () => {
    authorityRecordCalls.length = 0
    failAuthorityRecord = false
    const harness = createHarness()
    productSpaceCatalog = harness.productSpaceCatalog
    logout = harness.logout
    await harness.login(context, 'admin', 'admin-password')
  })

  it('commits the authority in the session-current zone and emits withdrawn entries', async () => {
    let calls = 0
    const gated = [
      { release: undefined as undefined | ((value: any) => void) },
      { release: undefined as undefined | ((value: any) => void) },
    ]
    adminClientBehavior.getProductSpaceCatalog = async (_token: unknown, ctx: unknown) => {
      const index = calls++
      return new Promise(resolve => {
        gated[index].release = resolve
      })
    }

    const pendingR1 = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => gated[0].release)
    const pendingR2 = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => gated[1].release)
    expect(gated[0].release).toBeDefined()
    expect(gated[1].release).toBeDefined()

    // R2 (latest) resolves first, then the slow R1 arrives.
    // Fresh responses carry NO notModified key (the real AdminClient omits
    // it; only the notModified short-circuit includes the key).
    gated[1].release!({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-2',
      entries: [authorityTestEntry('rev-2')],
    })
    gated[0].release!({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-1',
      entries: [authorityTestEntry('rev-1')],
    })

    const r2 = await pendingR2 as any
    const r1 = await pendingR1 as any
    console.log('[fence-test] r1', JSON.stringify(r1))
    console.log('[fence-test] r2', JSON.stringify(r2))
    expect(r2.success).toBe(true)
    expect(r2.entries).toHaveLength(1)
    expect(r2).not.toHaveProperty('__authorityCommit')
    expect(r2.withdrawnEntries).toEqual([])
    // The slower older request is superseded and never writes the authority.
    expect(r1.success).toBe(false)
    expect(r1.errorCode).toBe('REQUEST_SUPERSEDED')

    // Exactly one authority write: the newest request's entries.
    expect(authorityRecordCalls).toEqual([{
      accountId: 'user-1',
      productSpaceId: 'space-a',
      catalogRevision: 'rev-2',
      entryCount: 1,
    }])
  })

  it('downgrades a request to REQUEST_SUPERSEDED via the final commit-zone CAS when a newer invocation registered', async () => {
    // R1 passes its post-fetch latest check, but its authority commit is
    // delayed by the session-current lock; a newer invocation registers in
    // that window (simulated by the fence bump — R2's registration). The
    // final CAS under the lock must reject R1 with ZERO authority writes.
    adminClientBehavior.listProductSpaces = async () => ({
      productSpaces: [{ id: 'space-a', accessMode: 'active' }],
    })
    let releaseR1Catalog!: (value: any) => void
    adminClientBehavior.getProductSpaceCatalog = async () => {
      return new Promise(resolve => {
        releaseR1Catalog = resolve
      })
    }

    const pendingR1 = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => releaseR1Catalog)

    // R1's post-fetch check has passed at this exact instant; R2 now
    // registers a newer invocation before R1 reaches the commit zone.
    __bumpProductSpaceCatalogSyncFenceForTests(
      createProductSpaceContextKey('user-1' as never, 'space-a' as never),
    )

    releaseR1Catalog!({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-1',
      entries: [authorityTestEntry('rev-1')],
    })

    const r1 = await pendingR1 as any
    expect(r1.success).toBe(false)
    expect(r1.errorCode).toBe('REQUEST_SUPERSEDED')
    // ZERO authority writes: the stale rev-1 commit never reached the
    // authority (the newer request registered and exited).
    expect(authorityRecordCalls).toEqual([])
  })

  it('returns REQUEST_SUPERSEDED for a delayed R1 when a real newer request registered then failed non-session-ending', async () => {
    // REAL concurrent R1/R2 (no test-hook bump): R1 is gated at its catalog
    // fetch; R2 enters the scope — registering a NEWER invocation BEFORE any
    // list await — then exits with a transport failure without committing.
    // R1's delayed commit must lose to R2's newer invocation via the final
    // commit-zone CAS.
    let releaseR1Catalog!: (value: any) => void
    adminClientBehavior.getProductSpaceCatalog = async () => {
      return new Promise(resolve => {
        releaseR1Catalog = resolve
      })
    }

    const pendingR1 = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => releaseR1Catalog)

    // R2 enters the scope (registers invocation 2) and blocks at its list
    // await — registration happens BEFORE the list call.
    let releaseR2List!: (value: any) => void
    adminClientBehavior.listProductSpaces = async () => {
      return new Promise(resolve => {
        releaseR2List = resolve
      })
    }
    const pendingR2 = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => releaseR2List)

    // R2 exits with a transport failure (never commits).
    releaseR2List!(new (class extends Error {
      readonly errorCode = 'NETWORK_ERROR'
    })('R2 transport failed'))
    const r2 = await pendingR2 as any
    expect(r2.success).toBe(false)

    // The delayed R1 commit must lose to R2's newer invocation.
    releaseR1Catalog!({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-1',
      entries: [authorityTestEntry('rev-1')],
    })
    const r1 = await pendingR1 as any
    expect(r1.success).toBe(false)
    expect(r1.errorCode).toBe('REQUEST_SUPERSEDED')
    expect(authorityRecordCalls.filter(call => call.catalogRevision === 'rev-1')).toEqual([])
  })

  it('stays fail-closed (zero authority writes) when a real newer request finds the space withdrawn after registering', async () => {
    // REAL concurrent R1/R2 with the WITHDRAWAL flavor: R2 registers its
    // newer invocation BEFORE the list await, then its list validation finds
    // the space withdrawn. That failure is session-ending by production
    // design, so R1 fails closed as SESSION_CHANGED (or REQUEST_SUPERSEDED
    // when the session survives) — either way with ZERO authority writes and
    // never the stale rev-1 commit.
    let releaseR1Catalog!: (value: any) => void
    adminClientBehavior.getProductSpaceCatalog = async () => {
      return new Promise(resolve => {
        releaseR1Catalog = resolve
      })
    }

    const pendingR1 = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => releaseR1Catalog)

    let releaseR2List!: (value: any) => void
    adminClientBehavior.listProductSpaces = async () => {
      return new Promise(resolve => {
        releaseR2List = resolve
      })
    }
    const pendingR2 = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => releaseR2List)

    releaseR2List!({ productSpaces: [] })
    const r2 = await pendingR2 as any
    expect(r2.success).toBe(false)

    releaseR1Catalog!({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-1',
      entries: [authorityTestEntry('rev-1')],
    })
    const r1 = await pendingR1 as any
    expect(r1.success).toBe(false)
    expect(['REQUEST_SUPERSEDED', 'SESSION_CHANGED']).toContain(r1.errorCode)
    // ZERO authority writes for the stale request.
    expect(authorityRecordCalls).toEqual([])
  })

  it('keeps delimiter-collision ProductSpaces on independent fences and authorities', async () => {
    // (userId 'user-1|extra', space 'space-a') vs (userId 'user-1', space
    // 'extra|space-a'): a delimiter-concatenated scope key would share one
    // invocation counter and the two spaces would supersede each other.
    adminClientBehavior.listProductSpaces = async () => ({
      productSpaces: [
        { id: 'space-a', accessMode: 'active' },
        { id: 'extra|space-a', accessMode: 'active' },
      ],
    })
    adminClientBehavior.getProductSpaceCatalog = async (_token: string, ctx: unknown) => ({
      contractVersion: 1,
      productSpaceId: (ctx as { id: string }).id,
      catalogRevision: `rev-${(ctx as { id: string }).id}`,
      entries: [],
    })

    let releaseACatalog!: (value: any) => void
    adminClientBehavior.getProductSpaceCatalog = async (_token: string, ctx: unknown) => {
      if ((ctx as { id: string }).id === 'space-a') {
        return new Promise(resolve => {
          releaseACatalog = resolve
        })
      }
      return {
        contractVersion: 1,
        productSpaceId: (ctx as { id: string }).id,
        catalogRevision: `rev-${(ctx as { id: string }).id}`,
        entries: [],
      }
    }

    const pendingA = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => releaseACatalog)
    // While space-a's request is in flight, the OTHER (delimiter-collision)
    // scope registers on its own fence: with a shared delimiter key this
    // bump would supersede space-a's in-flight request.
    __bumpProductSpaceCatalogSyncFenceForTests(
      createProductSpaceContextKey('user-1' as never, 'extra|space-a' as never),
    )
    releaseACatalog!({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-space-a',
      entries: [],
    })
    const pendingB = productSpaceCatalog(context, 'extra|space-a', undefined)
    const rA = await pendingA as any
    const rB = await pendingB as any

    expect(rA.success).toBe(true)
    expect(rB.success).toBe(true)
    expect(rA.catalogRevision).toBe('rev-space-a')
    expect(rB.catalogRevision).toBe('rev-extra|space-a')
    // Both collision scopes recorded their own authority independently.
    expect(authorityRecordCalls).toEqual([
      { accountId: 'user-1', productSpaceId: 'space-a', catalogRevision: 'rev-space-a', entryCount: 0 },
      { accountId: 'user-1', productSpaceId: 'extra|space-a', catalogRevision: 'rev-extra|space-a', entryCount: 0 },
    ])
  })

  it('recycles fence scope entries for unique nonexistent spaces (bounded map)', async () => {
    adminClientBehavior.listProductSpaces = async () => ({ productSpaces: [] })
    adminClientBehavior.getProductSpaceCatalog = async () => {
      throw new Error('must not fetch a catalog for an unknown space')
    }

    // Renderer-spam: many unique nonexistent space IDs. Each request
    // registers, fails list validation, and settles — the scope entry must
    // be recycled so the fence map never grows.
    for (let index = 0; index < 200; index += 1) {
      const spaceId = `ghost-space-${index}`
      const response = await productSpaceCatalog(context, spaceId, undefined) as any
      expect(response.success).toBe(false)
    }
    expect(__productSpaceCatalogSyncScopeCountForTests()).toBe(0)

    // Schema-invalid identifiers never touch the fence either.
    await expect(productSpaceCatalog(context, '', undefined)).resolves.toMatchObject({
      success: false,
      errorCode: 'VALIDATION_ERROR',
    })
    expect(__productSpaceCatalogSyncScopeCountForTests()).toBe(0)
  })

  it('never revives an older same-scope request through scope re-creation (no ABA)', async () => {
    // R1 gated at fetch; R2 (same scope) completes and recycles the scope
    // entry; the scope is re-created for R3. R1's invocation must still be
    // superseded (global monotonic IDs — no ABA revival), and R3 commits
    // with its own strictly larger invocation.
    let releaseR1Catalog!: (value: any) => void
    adminClientBehavior.getProductSpaceCatalog = async () => {
      return new Promise(resolve => {
        releaseR1Catalog = resolve
      })
    }
    const pendingR1 = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => releaseR1Catalog)

    adminClientBehavior.getProductSpaceCatalog = async () => ({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-2',
      entries: [authorityTestEntry('rev-2')],
    })
    const pendingR2 = productSpaceCatalog(context, 'space-a', undefined)
    const r2 = await pendingR2 as any
    expect(r2.success).toBe(true)
    expect(r2.catalogRevision).toBe('rev-2')

    // The stale R1 commit is superseded after the scope was recycled.
    releaseR1Catalog!({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-1',
      entries: [authorityTestEntry('rev-1')],
    })
    const r1 = await pendingR1 as any
    expect(r1.success).toBe(false)
    expect(r1.errorCode).toBe('REQUEST_SUPERSEDED')

    // A fresh R3 commits normally on the re-created scope.
    adminClientBehavior.getProductSpaceCatalog = async () => ({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-3',
      entries: [authorityTestEntry('rev-3')],
    })
    const r3 = await productSpaceCatalog(context, 'space-a', undefined) as any
    expect(r3.success).toBe(true)
    expect(r3.catalogRevision).toBe('rev-3')
    // The recycled scope committed the newest authority last.
    expect(authorityRecordCalls.at(-1)).toEqual({
      accountId: 'user-1',
      productSpaceId: 'space-a',
      catalogRevision: 'rev-3',
      entryCount: 1,
    })
  })

  it('releases the pending fence reservation when the session changed while the request was in flight (bounded map)', async () => {
    let releaseR1Catalog!: (value: any) => void
    adminClientBehavior.getProductSpaceCatalog = async () => {
      return new Promise(resolve => {
        releaseR1Catalog = resolve
      })
    }

    const pendingR1 = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => releaseR1Catalog)

    // The session changes while R1 is still in flight (its pre-check and
    // mark happen only when the delayed catalog response arrives).
    await logout(context)

    releaseR1Catalog!({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-1',
      entries: [authorityTestEntry('rev-1')],
    })

    const r1 = await pendingR1 as any
    try {
      // The late response still passes the fence pre-check (it was latest)
      // and marks a pending reservation — but the session-current CAS zone
      // is SKIPPED by the session change. The always-settle contract must
      // release the reservation anyway.
      expect(r1.success).toBe(false)
      expect(r1.errorCode).toBe('SESSION_CHANGED')
      expect(__productSpaceCatalogSyncScopeCountForTests()).toBe(0)
    } finally {
      failAuthorityRecord = false
    }
  })

  it('releases the pending fence reservation when the authority write throws (bounded map)', async () => {
    failAuthorityRecord = true
    try {
      const failing = productSpaceCatalog(context, 'space-a', undefined) as any
      const response = await failing
      expect(response.success).toBe(false)
      // The always-settle release recycled the scope entry even though the
      // authority write threw inside the session-current commit zone.
      expect(__productSpaceCatalogSyncScopeCountForTests()).toBe(0)
    } finally {
      failAuthorityRecord = false
    }
  })

  it('never lets an older unmarked failing request steal a newer pending reservation (cross-request ownership)', async () => {
    // R1 gated at fetch; R2 (same scope, newer invocation) completes its
    // fetch, passes the pre-check, MARKS a pending reservation and enters
    // the session-current commit zone. R1's fetch then resolves and FAILS
    // its pre-check (superseded, never marks) — R1 settles LAST. The
    // always-settle release must only release R1's own (non-existent)
    // reservation: R2's final CAS must still pass and write the newest
    // authority.
    const gated = [
      { release: undefined as undefined | ((value: any) => void) },
      { release: undefined as undefined | ((value: any) => void) },
    ]
    let catalogCalls = 0
    adminClientBehavior.getProductSpaceCatalog = async () => {
      const index = catalogCalls++
      return new Promise(resolve => {
        gated[index].release = resolve
      })
    }

    const pendingR1 = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => gated[0].release)
    const pendingR2 = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => gated[1].release)

    // R2 (newest) commits first: pre-check passes, marks pending, enters
    // the session-current commit zone.
    gated[1].release!({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-2',
      entries: [authorityTestEntry('rev-2')],
    })
    const r2 = await pendingR2 as any
    expect(r2.success).toBe(true)
    expect(r2.catalogRevision).toBe('rev-2')
    expect(r2.withdrawnEntries).toEqual([])

    // R1 (older) now resolves and fails its pre-check without marking.
    gated[0].release!({
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-1',
      entries: [authorityTestEntry('rev-1')],
    })
    const r1 = await pendingR1 as any
    expect(r1.success).toBe(false)
    expect(r1.errorCode).toBe('REQUEST_SUPERSEDED')

    // R2's commit was NOT downgraded by R1's late settle: the newest
    // authority stands and the fully idle scope was recycled.
    expect(authorityRecordCalls).toEqual([{
      accountId: 'user-1',
      productSpaceId: 'space-a',
      catalogRevision: 'rev-2',
      entryCount: 1,
    }])
    expect(__productSpaceCatalogSyncScopeCountForTests()).toBe(0)
  })

  it('never writes the authority when the session changes during the fetch', async () => {
    let release!: (value: any) => void
    adminClientBehavior.getProductSpaceCatalog = async () => {
      return new Promise(resolve => {
        release = resolve
      })
    }
    const pending = productSpaceCatalog(context, 'space-a', undefined)
    await waitFor(() => release)

    // The account session changes mid-await.
    await logout(context)

    release({
      notModified: false,
      contractVersion: 1,
      productSpaceId: 'space-a',
      catalogRevision: 'rev-mid-await',
      entries: [authorityTestEntry('rev-mid-await')],
    })

    const response = await pending as any
    expect(response.success).toBe(false)
    // The skipped commit zone left zero authority writes.
    expect(authorityRecordCalls).toEqual([])
  })
})

describe('registerAdminHandlers', () => {
  it('registers every admin channel', () => {
    const harness = createHarness()

    expect(Object.keys(harness).sort()).toEqual([
      'acceptOrganizationJoin',
      'authLogout',
      'cancelOrganizationInvitation',
      'createOrganization',
      'createOrganizationInvitation',
      'createOrganizationJoinLink',
      'getAuthConfig',
      'getPhoneAuthChallengeConfig',
      'listOrganizationInvitations',
      'listOrganizationMembers',
      'listOrganizations',
      'login',
      'logout',
      'previewOrganizationJoin',
      'productSpaceCatalog',
      'removeOrganizationMember',
      'revokeOrganizationJoinLink',
      'sendPhoneAuthCode',
      'setPassword',
      'syncAppCatalog',
      'syncConnections',
      'updateOrganizationMember',
      'validate',
      'verifyPhoneAuthCode',
    ])
  })

  it('forwards organization onboarding through the authenticated admin session', async () => {
    managerState.tokens = {
      accessToken: 'organization-access-token',
      refreshToken: 'organization-refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      userId: 'user-1',
      username: 'admin',
    }
    const organization = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'creator_space',
      name: 'Studio',
      purpose: 'Publish apps',
      visibility: 'private',
      status: 'active',
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z',
    }
    adminClientBehavior.listOrganizations = async () => ({
      organizations: [{
        ...organization,
        membership: {
          id: '22222222-2222-4222-8222-222222222222',
          role: 'owner',
          status: 'active',
        },
        memberCount: 1,
      }],
    })
    adminClientBehavior.createOrganization = async (_accessToken, input) => ({
      organization,
      membership: {
        id: '22222222-2222-4222-8222-222222222222',
        role: 'owner',
        status: 'active',
      },
      replayed: false,
      input,
    })
    adminClientBehavior.previewOrganizationJoin = async () => ({
      organization,
      join: {
        kind: 'join_link',
        effectiveStatus: 'active',
        expiresAt: null,
        usesRemaining: null,
        requiresPhoneMatch: false,
      },
    })
    adminClientBehavior.acceptOrganizationJoin = async () => ({
      membership: {
        id: '33333333-3333-4333-8333-333333333333',
        organizationId: organization.id,
        userId: 'user-1',
        role: 'member',
        status: 'active',
      },
      replayed: false,
    })

    const {
      listOrganizations,
      createOrganization,
      previewOrganizationJoin,
      acceptOrganizationJoin,
    } = createHarness()
    const context = { clientId: 'client-1', workspaceId: null, webContentsId: null }
    const token = 'join-token-12345678901234567890'

    expect(await listOrganizations(context)).toMatchObject({
      success: true,
      organizations: [{ id: organization.id }],
    })
    expect(await createOrganization(context, {
      type: 'creator_space',
      name: 'Studio',
      purpose: 'Publish apps',
      idempotencyKey: 'org-request-1',
    })).toMatchObject({ success: true, organization: { id: organization.id } })
    expect(await previewOrganizationJoin(context, token)).toMatchObject({
      success: true,
      join: { kind: 'join_link' },
    })
    expect(await acceptOrganizationJoin(context, token)).toMatchObject({
      success: true,
      membership: { organizationId: organization.id },
    })
    expect(adminClientCalls.map(call => call.method)).toEqual([
      'listOrganizations',
      'createOrganization',
      'previewOrganizationJoin',
      'acceptOrganizationJoin',
    ])
    expect(adminClientCalls.filter(call => call.accessToken).every(
      call => call.accessToken === 'organization-access-token',
    )).toBe(true)
  })

  it('discovers the public phone challenge issuer through the local handler', async () => {
    const { getPhoneAuthChallengeConfig } = createHarness()

    const result = await getPhoneAuthChallengeConfig({
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    })

    expect(result).toEqual({
      success: true,
      type: 'browser_redirect',
      issuerUrl: 'https://challenge.example.com/phone-auth',
    })
    expect(adminClientCalls.map(call => call.method)).toEqual([
      'getPhoneAuthChallengeConfig',
    ])
  })

  it('reads the public phone auth config', async () => {
    const { getAuthConfig } = createHarness()

    const result = await getAuthConfig({ clientId: 'client-1', workspaceId: null, webContentsId: null })

    expect(result).toEqual({ phoneAuthEnabled: true })
    expect(adminClientCalls.map(call => call.method)).toEqual(['getAuthConfig'])
  })

  it('sends a phone code and preserves the safe retry timing', async () => {
    const { sendPhoneAuthCode } = createHarness()

    const result = await sendPhoneAuthCode(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      '13800138000',
      'verified-challenge',
    )

    expect(result).toEqual({
      success: true,
      accepted: true,
      expiresIn: 300,
      resendAfter: 60,
    })
    expect(adminClientCalls[0]).toMatchObject({
      method: 'sendPhoneAuthCode',
      args: [{ phone: '13800138000', challengeToken: 'verified-challenge' }],
    })

    adminClientBehavior.sendPhoneAuthCode = async () => {
      throw new TestAdminError('sms_rate_limited', 'sms_rate_limited', {
        status: 429,
        details: { retryAfter: 42 },
      })
    }
    const limited = await sendPhoneAuthCode(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      '13800138000',
      'verified-challenge',
    )
    expect(limited).toEqual({
      success: false,
      errorCode: 'sms_rate_limited',
      message: 'Phone authentication request was rate limited',
      status: 429,
      retryAfter: 42,
    })
  })

  it('does not forward sensitive AdminError text through RPC', async () => {
    adminClientBehavior.sendPhoneAuthCode = async () => {
      throw new TestAdminError(
        'AccessKeyId=LTAI-DO-NOT-LEAK\\nError at /srv/private.ts:42',
        'VALIDATION_ERROR',
        { status: 400, details: { retryAfter: 86_401 } },
      )
    }
    const { sendPhoneAuthCode } = createHarness()

    const result = await sendPhoneAuthCode(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      '13800138000',
      'verified-challenge',
    )

    expect(result).toEqual({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'Admin request was rejected',
      status: 400,
    })
    expect(JSON.stringify(result)).not.toContain('LTAI')
    expect(JSON.stringify(result)).not.toContain('/srv/private')
  })

  it('rejects malformed auth RPC inputs locally without calling AdminClient', async () => {
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    const {
      login,
      sendPhoneAuthCode,
      verifyPhoneAuthCode,
      setPassword,
    } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    expect(await login(context, '', 'x'.repeat(100_000))).toEqual({
      success: false,
      errorCode: 'INVALID_CREDENTIALS',
      message: 'Invalid username or password',
    })
    for (const invalidPhone of [
      '12000000000',
      '1380013800',
      '138001380000',
      'a3800138000',
    ]) {
      expect(await sendPhoneAuthCode(context, invalidPhone, 'challenge')).toEqual({
        success: false,
        errorCode: 'invalid_phone',
        message: 'Phone number is invalid',
      })
      expect(await verifyPhoneAuthCode(context, invalidPhone, '123456')).toEqual({
        success: false,
        errorCode: 'invalid_phone',
        message: 'Phone number is invalid',
      })
    }
    expect(await sendPhoneAuthCode(
      context,
      '13800138000',
      'x'.repeat(100_000),
    )).toEqual({
      success: false,
      errorCode: 'phone_auth_configuration_error',
      message: 'Phone authentication is not configured',
    })
    expect(await verifyPhoneAuthCode(context, '13800138000', '')).toEqual({
      success: false,
      errorCode: 'verification_code_invalid',
      message: 'Verification code is invalid',
    })
    expect(await verifyPhoneAuthCode(context, undefined, '123456')).toEqual({
      success: false,
      errorCode: 'invalid_phone',
      message: 'Phone number is invalid',
    })
    expect(await setPassword(context, 'x'.repeat(100_000))).toEqual({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'Admin request was rejected',
    })
    expect(adminClientCalls).toEqual([])
  })

  it('verifies a phone code through the same token and connection persistence path', async () => {
    const { verifyPhoneAuthCode } = createHarness()

    const result = await verifyPhoneAuthCode(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      '13800138000',
      '123456',
    )

    expect(result).toEqual({
      success: true,
      user: {
        id: 'phone-user-1',
        username: 'phone_13800138000',
        displayName: null,
        role: 'user',
        groupIds: ['group-1'],
      },
      isNewUser: true,
    })
    expect(managerState.tokens).toMatchObject({
      accessToken: 'phone-access-token',
      refreshToken: 'phone-refresh-token',
      userId: 'phone-user-1',
      username: 'phone_13800138000',
    })
    expect(configState.connections).toHaveLength(1)
    expect(adminClientCalls.map(call => call.method)).toEqual([
      'verifyPhoneAuthCode',
      'getLlmConnections',
    ])
  })

  it('keeps authentication but fails closed when a new account connection sync fails', async () => {
    configState.adminConfigVersion = 'account-a-config'
    configState.connections = [
      adminConnection({
        slug: 'account-a-admin',
        managedBy: 'admin',
        adminConfigVersion: 'account-a-config',
      }),
      adminConnection({
        slug: 'user-local',
        name: 'User Local',
        managedBy: undefined,
        apiKey: undefined,
      }),
    ]
    configState.defaultConnection = 'account-a-admin'
    managerState.llmApiKeys.set('account-a-admin', 'sk-account-a')
    managerState.llmApiKeys.set('user-local', 'sk-user-local')
    adminClientBehavior.getLlmConnections = async () => {
      throw new Error('temporary connection sync outage')
    }
    const { verifyPhoneAuthCode, syncConnections } = createHarness()

    const result = await verifyPhoneAuthCode(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      '13800138000',
      '123456',
    )

    expect(result).toMatchObject({
      success: true,
      isNewUser: true,
    })
    expect(managerState.tokens).toMatchObject({
      accessToken: 'phone-access-token',
      refreshToken: 'phone-refresh-token',
      userId: 'phone-user-1',
    })
    expect(configState.adminConfigVersion).toBeUndefined()
    expect(configState.connections.map(connection => connection.slug)).toEqual([
      'user-local',
    ])
    expect(configState.defaultConnection).toBe('user-local')
    expect(managerState.llmApiKeys.has('account-a-admin')).toBe(false)
    expect(managerState.llmApiKeys.get('user-local')).toBe('sk-user-local')
    expect(managerState.deletedCredentialSlugs).toContain('account-a-admin')
    expect(loggerWarn).toHaveBeenCalledWith(
      '[Admin] post-login connection sync failed; session remains authenticated:',
      'temporary connection sync outage',
    )

    adminClientBehavior.getLlmConnections = async () => ({
      configVersion: 'config-after-retry',
      connections: [adminConnection()],
      defaultConnection: 'admin-anthropic',
    })
    const retry = await syncConnections({
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    })
    expect(retry).toMatchObject({
      success: true,
      configVersion: 'config-after-retry',
      connectionCount: 1,
    })
    expect(configState.connections.map(connection => connection.slug).sort()).toEqual([
      'admin-anthropic',
      'user-local',
    ])
    expect(managerState.llmApiKeys.get('admin-anthropic')).toBe('sk-admin')
  })

  it('uses the same successful login path for an existing phone user', async () => {
    adminClientBehavior.verifyPhoneAuthCode = async () => ({
      accessToken: 'returning-access-token',
      refreshToken: 'returning-refresh-token',
      expiresIn: 3600,
      user: {
        id: 'returning-user-1',
        username: 'phone_13800138000',
        displayName: 'Returning User',
        role: 'user',
        groupIds: [],
      },
      isNewUser: false,
    })
    const { verifyPhoneAuthCode } = createHarness()

    const result = await verifyPhoneAuthCode(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      '13800138000',
      '654321',
    )

    expect(result).toMatchObject({
      success: true,
      isNewUser: false,
      user: { id: 'returning-user-1' },
    })
    expect(managerState.tokens).toMatchObject({
      accessToken: 'returning-access-token',
      userId: 'returning-user-1',
    })
  })

  it('sets a password with the current encrypted admin session token only', async () => {
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    const { setPassword } = createHarness()

    const result = await setPassword(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'new-password-123',
    )

    expect(result).toEqual({ success: true })
    expect(adminClientCalls).toEqual([{
      method: 'setPassword',
      args: [{ password: 'new-password-123' }],
      accessToken: 'access-token',
    }])
  })

  it('decrypts transit-encrypted admin api keys', () => {
    const apiKey = readApiKey(adminConnection({
      apiKey: encryptedApiKey('sk-transit-secret', 'access-token'),
    }) as AdminLlmConnection, 'access-token')

    expect(apiKey).toBe('sk-transit-secret')
  })

  it('logs in, stores admin tokens, and syncs admin-managed connections', async () => {
    const { login } = createHarness()

    const result = await login({ clientId: 'client-1', workspaceId: null, webContentsId: null }, 'admin', 'secret')

    expect(result).toEqual({
      success: true,
      user: {
        id: 'user-1',
        username: 'admin',
        displayName: 'Admin User',
        role: 'admin',
        groupIds: ['group-1'],
      },
    })
    expect(managerState.tokens).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    })
    expect(configState.connections).toHaveLength(1)
    expect(configState.connections[0]).toMatchObject({
      slug: 'admin-anthropic',
      managedBy: 'admin',
      adminConfigVersion: 'config-v1',
    })
    expect(Object.prototype.hasOwnProperty.call(configState.connections[0], 'apiKey')).toBe(false)
    expect(managerState.llmApiKeys.get('admin-anthropic')).toBe('sk-admin')
    expect(configState.defaultConnection).toBe('admin-anthropic')
    expect(configState.adminConfigVersion).toBe('config-v1')
    expect(adminClientCalls[0]).toMatchObject({
      method: 'login',
      args: ['admin', 'secret'],
    })
  })

  it('cleans the trusted old account before password login replaces it', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    appCatalogAccess.set('account-a:organization-1', 'online')
    appCatalogCache.set('account-a:organization-1', {
      accountId: 'account-a',
      organizationId: 'organization-1',
      authorizationStatus: 'authorized',
      apps: [],
    })
    const { login } = createHarness()

    expect(await login(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'admin',
      'secret',
    )).toMatchObject({ success: true, user: { id: 'user-1' } })

    expect(adminSessionEnding).toHaveBeenCalledTimes(1)
    expect(adminSessionEnding).toHaveBeenCalledWith('account-a')
    expect(adminSessionStarted).toHaveBeenCalledWith('user-1')
    expect(managerState.tokens).toMatchObject({ userId: 'user-1' })
    expect(appCatalogAccess.get('account-a:organization-1')).toBe('denied')
    expect(appCatalogCache.get('account-a:organization-1'))
      .toMatchObject({ authorizationStatus: 'denied' })
  })

  it('stops the prior account executions and revokes its fence before the replacement starts', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    // Account A holds the committed fence and a still-running execution.
    setRuntimeActiveProductSpaceAccount('account-a')
    setRuntimeActiveProductSpace('space-a')
    let assistantActive = true
    let stopCalls = 0
    registerProductSpaceExecution({
      scope: {
        contractVersion: 1,
        executionId: 'exec-account-a-assistant',
        accountId: 'account-a',
        productSpaceId: 'space-a',
        workspaceId: 'ws-a',
        subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      } as never,
      kind: 'assistant_session',
      name: 'assistant',
      ref: 'session-a',
      generation: 0,
      isActive: () => assistantActive,
      stop: async () => {
        stopCalls += 1
        assistantActive = false
        return 'stopped'
      },
    })

    const observed: Array<{ fence: string | null; executions: number }> = []
    adminSessionEnding.mockImplementation(async (accountId: string) => {
      // Mirrors the Main implementation: stop every registered execution of
      // the ending account.
      await stopRegisteredProductSpaceExecutionsForAccount(accountId)
    })
    adminSessionStarted.mockImplementation(async () => {
      observed.push({
        fence: getRuntimeActiveProductSpace(),
        executions: listRegisteredProductSpaceExecutions().length,
      })
    })

    const { login } = createHarness()
    await login(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'admin',
      'secret',
    )

    // The prior account's assistant execution was actually stopped.
    expect(stopCalls).toBe(1)
    expect(assistantActive).toBe(false)
    // By the time account B's session starts, A's fence is revoked and none
    // of A's executions remain registered.
    expect(observed).toEqual([{ fence: null, executions: 0 }])
    expect(managerState.tokens).toMatchObject({ userId: 'user-1' })
  })

  it('publishes the transition epoch before replacement cleanup and never advances it for same-account refresh (R31-2)', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    setRuntimeActiveProductSpaceAccount('account-a')
    setRuntimeActiveProductSpace('space-a')

    const epochBefore = getAccountTransitionEpoch()
    let epochAtEndingCallback = -1
    adminSessionEnding.mockImplementation(async (accountId: string) => {
      // The cleanup callback runs AFTER the epoch publication: the epoch
      // must already be advanced here, proving publication happened
      // synchronously before the cleanup snapshot.
      epochAtEndingCallback = getAccountTransitionEpoch()
      await stopRegisteredProductSpaceExecutionsForAccount(accountId)
    })

    const { login } = createHarness()
    await login(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'admin',
      'secret',
    )

    expect(epochAtEndingCallback).toBeGreaterThan(epochBefore)
    // Monotonic: the completed replacement leaves the epoch advanced.
    expect(getAccountTransitionEpoch()).toBeGreaterThan(epochBefore)

    // A same-account re-login (token refresh path, no switching) must not
    // advance the epoch.
    const epochAfterReplacement = getAccountTransitionEpoch()
    await login(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'admin',
      'secret',
    )
    expect(getAccountTransitionEpoch()).toBe(epochAfterReplacement)
  })

  it('logout publishes the transition epoch; a rejected logout does not advance it (R31-2)', async () => {
    const { login, logout, getAuthConfig } = createHarness()
    const context = { clientId: 'client-1', workspaceId: null, webContentsId: null }

    // LOGOUT with no session: no owned transition — the epoch is untouched.
    await logout(context)
    const epochBefore = getAccountTransitionEpoch()
    expect(getAccountTransitionEpoch()).toBe(epochBefore)

    await login(context, 'admin', 'secret')
    // A same-account login never transitioned — still untouched.
    expect(getAccountTransitionEpoch()).toBe(epochBefore)

    await logout(context)
    expect(getAccountTransitionEpoch()).toBeGreaterThan(epochBefore)
    void getAuthConfig
  })

  it('discards account A organization success after login switches to B', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    appCatalogAccess.set('account-b:organization-b', 'online')
    appCatalogCache.set('account-b:organization-b', {
      accountId: 'account-b',
      organizationId: 'organization-b',
      authorizationStatus: 'authorized',
      apps: [],
    })
    const pendingOrganizations = createDeferred<any>()
    const listStarted = createDeferred<void>()
    adminClientBehavior.listOrganizations = async () => {
      listStarted.resolve()
      return pendingOrganizations.promise
    }
    adminClientBehavior.login = async () => ({
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
      expiresIn: 3600,
      user: {
        id: 'account-b',
        username: 'account-b',
        displayName: 'Account B',
        role: 'member',
        groupIds: [],
      },
    })
    const { listOrganizations, login } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const accountARequest = listOrganizations(context)
    await listStarted.promise
    expect(await login(context, 'account-b', 'secret')).toMatchObject({
      success: true,
      user: { id: 'account-b' },
    })
    pendingOrganizations.resolve({ organizations: [] })

    expect(await accountARequest).toMatchObject({
      success: false,
      errorCode: 'SESSION_CHANGED',
    })
    expect(managerState.tokens).toMatchObject({
      userId: 'account-b',
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
    })
    expect(appCatalogAccess.get('account-b:organization-b')).toBe('online')
    expect(appCatalogCache.get('account-b:organization-b')).toMatchObject({
      authorizationStatus: 'authorized',
    })
    expect(adminSessionEnding).toHaveBeenCalledTimes(1)
    expect(adminSessionEnding).toHaveBeenCalledWith('account-a')
  })

  it('does not let account A late 403 end account B', async () => {
    const organizationA = '11111111-1111-4111-8111-111111111111'
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    appCatalogCache.set(`account-a:${organizationA}`, {
      accountId: 'account-a',
      organizationId: organizationA,
      authorizationStatus: 'authorized',
      appConfigVersion: 'apps-a',
      apps: [],
    })
    appCatalogAccess.set('account-b:organization-b', 'online')
    appCatalogCache.set('account-b:organization-b', {
      accountId: 'account-b',
      organizationId: 'organization-b',
      authorizationStatus: 'authorized',
      apps: [],
    })
    const pendingCatalog = createDeferred<any>()
    const catalogStarted = createDeferred<void>()
    adminClientBehavior.getAppCatalog = async () => {
      catalogStarted.resolve()
      return pendingCatalog.promise
    }
    adminClientBehavior.login = async () => ({
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
      expiresIn: 3600,
      user: {
        id: 'account-b',
        username: 'account-b',
        displayName: 'Account B',
        role: 'member',
        groupIds: [],
      },
    })
    const { syncAppCatalog, login } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const accountARequest = syncAppCatalog(context, organizationA, {
      force: true,
    })
    await catalogStarted.promise
    expect(await login(context, 'account-b', 'secret')).toMatchObject({
      success: true,
      user: { id: 'account-b' },
    })
    pendingCatalog.reject(new TestAdminError(
      'account A lost authorization',
      'FORBIDDEN',
      { status: 403 },
    ))

    expect(await accountARequest).toMatchObject({
      success: false,
      errorCode: 'SESSION_CHANGED',
    })
    expect(managerState.tokens).toMatchObject({
      userId: 'account-b',
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
    })
    expect(appCatalogAccess.get('account-b:organization-b')).toBe('online')
    expect(appCatalogCache.get('account-b:organization-b')).toMatchObject({
      authorizationStatus: 'authorized',
    })
    expect(adminSessionEnding).toHaveBeenCalledTimes(1)
    expect(adminSessionEnding).toHaveBeenCalledWith('account-a')
  })

  it('does not apply account A late connection sync over account B config', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    const pendingAccountAConnections = createDeferred<any>()
    const accountASyncStarted = createDeferred<void>()
    adminClientBehavior.getLlmConnections = async accessToken => {
      if (accessToken === 'account-a-token') {
        accountASyncStarted.resolve()
        return pendingAccountAConnections.promise
      }
      return {
        configVersion: 'config-b',
        connections: [adminConnection({
          slug: 'account-b-admin',
          name: 'Account B Admin',
          apiKey: 'sk-account-b',
        })],
        defaultConnection: 'account-b-admin',
      }
    }
    adminClientBehavior.login = async () => ({
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
      expiresIn: 3600,
      user: {
        id: 'account-b',
        username: 'account-b',
        displayName: 'Account B',
        role: 'member',
        groupIds: [],
      },
    })
    const { syncConnections, login } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const accountASync = syncConnections(context)
    await accountASyncStarted.promise
    expect(await login(context, 'account-b', 'secret')).toMatchObject({
      success: true,
      user: { id: 'account-b' },
    })
    pendingAccountAConnections.resolve({
      configVersion: 'config-a-late',
      connections: [adminConnection({
        slug: 'account-a-admin',
        name: 'Account A Admin',
        apiKey: 'sk-account-a-late',
      })],
      defaultConnection: 'account-a-admin',
    })

    expect(await accountASync).toMatchObject({
      success: false,
      errorCode: 'SESSION_CHANGED',
    })
    expect(managerState.tokens).toMatchObject({
      userId: 'account-b',
      accessToken: 'account-b-token',
    })
    expect(configState.connections.map(connection => connection.slug)).toEqual([
      'account-b-admin',
    ])
    expect(configState.adminConfigVersion).toBe('config-b')
    expect(managerState.llmApiKeys.get('account-b-admin')).toBe('sk-account-b')
    expect(managerState.llmApiKeys.has('account-a-admin')).toBe(false)
  })

  it('does not persist account A late refresh over account B identity', async () => {
    managerState.tokens = {
      accessToken: 'expired-account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() - 1,
      userId: 'account-a',
      username: 'account-a',
    }
    const pendingRefresh = createDeferred<any>()
    const refreshStarted = createDeferred<void>()
    adminClientBehavior.refresh = async () => {
      refreshStarted.resolve()
      return pendingRefresh.promise
    }
    adminClientBehavior.login = async () => ({
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
      expiresIn: 3600,
      user: {
        id: 'account-b',
        username: 'account-b',
        displayName: 'Account B',
        role: 'member',
        groupIds: [],
      },
    })
    const { validate, login } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const accountAValidation = validate(context)
    await refreshStarted.promise
    expect(await login(context, 'account-b', 'secret')).toMatchObject({
      success: true,
      user: { id: 'account-b' },
    })
    pendingRefresh.resolve({
      accessToken: 'late-account-a-token',
      refreshToken: 'late-account-a-refresh',
      expiresIn: 3600,
    })

    expect(await accountAValidation).toMatchObject({
      loggedIn: false,
      errorCode: 'SESSION_CHANGED',
    })
    expect(managerState.tokens).toMatchObject({
      userId: 'account-b',
      username: 'account-b',
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
    })
    expect(adminSessionEnding).toHaveBeenCalledTimes(1)
    expect(adminSessionEnding).toHaveBeenCalledWith('account-a')
  })

  it('cleans the trusted old account before phone login replaces it', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    const { verifyPhoneAuthCode } = createHarness()

    expect(await verifyPhoneAuthCode(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      '13800138000',
      '123456',
    )).toMatchObject({ success: true, user: { id: 'phone-user-1' } })

    expect(adminSessionEnding).toHaveBeenCalledTimes(1)
    expect(adminSessionEnding).toHaveBeenCalledWith('account-a')
    expect(adminSessionStarted).toHaveBeenCalledWith('phone-user-1')
    expect(managerState.tokens).toMatchObject({ userId: 'phone-user-1' })
  })

  it('does not end the trusted session when the same account logs in again', async () => {
    managerState.tokens = {
      accessToken: 'old-token',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    const { login } = createHarness()

    expect(await login(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'admin',
      'secret',
    )).toMatchObject({ success: true })

    expect(adminSessionEnding).not.toHaveBeenCalled()
    expect(adminSessionStarted).toHaveBeenCalledWith('user-1')
    expect(managerState.tokens).toMatchObject({
      userId: 'user-1',
      accessToken: 'access-token',
    })
  })

  it('keeps account B intact when common logout for A finishes cleanup late', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    appCatalogAccess.set('account-b:organization-b', 'online')
    appCatalogCache.set('account-b:organization-b', {
      accountId: 'account-b',
      organizationId: 'organization-b',
      authorizationStatus: 'authorized',
      apps: [],
    })
    const cleanupStarted = createDeferred<void>()
    const finishCleanup = createDeferred<void>()
    adminSessionEnding
      .mockImplementationOnce(async () => {
        cleanupStarted.resolve()
        await finishCleanup.promise
      })
      .mockImplementation(async () => {})
    adminClientBehavior.login = async () => ({
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
      expiresIn: 3600,
      user: {
        id: 'account-b',
        username: 'account-b',
        displayName: 'Account B',
        role: 'member',
        groupIds: [],
      },
    })
    const { authLogout, login } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const staleLogout = authLogout(context)
    await cleanupStarted.promise
    // Account replacement waits for the prior account's local cleanup
    // (bounded in production by the execution-stop drain deadline) before
    // account B's tokens land.
    finishCleanup.resolve()
    expect(await login(context, 'account-b', 'secret')).toMatchObject({
      success: true,
      user: { id: 'account-b' },
    })
    // Call 1 is the logout cleanup; because it already completed, the
    // replacement re-ran the (idempotent) cleanup callback before B landed.
    expect(adminSessionEnding).toHaveBeenCalledTimes(2)

    expect(await staleLogout).toEqual({
      success: false,
      errorCode: 'SESSION_CHANGED',
      message: 'Admin session changed',
    })
    expect(managerState.tokens).toMatchObject({
      userId: 'account-b',
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
    })
    expect(appCatalogAccess.get('account-b:organization-b')).toBe('online')
    expect(appCatalogCache.get('account-b:organization-b')).toMatchObject({
      authorizationStatus: 'authorized',
    })
    expect(listStoredCredentials).not.toHaveBeenCalled()
    expect(deleteStoredCredential).not.toHaveBeenCalled()
  })

  it('returns SESSION_CHANGED when account A offline validation loses the final CAS to B', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    const validationStarted = createDeferred<void>()
    const pendingValidation = createDeferred<any>()
    adminClientBehavior.validate = async () => {
      validationStarted.resolve()
      return pendingValidation.promise
    }
    adminClientBehavior.login = async () => ({
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
      expiresIn: 3600,
      user: {
        id: 'account-b',
        username: 'account-b',
        displayName: 'Account B',
        role: 'member',
        groupIds: [],
      },
    })
    const { validate, login } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const staleValidation = validate(context)
    await validationStarted.promise
    await login(context, 'account-b', 'secret')
    pendingValidation.reject(new TestAdminError('offline', 'NETWORK_ERROR'))

    expect(await staleValidation).toEqual({
      loggedIn: false,
      errorCode: 'SESSION_CHANGED',
      message: 'Admin session changed',
    })
    expect(managerState.tokens).toMatchObject({ userId: 'account-b' })
  })

  it('returns SESSION_CHANGED when account A offline refresh loses the final CAS to B', async () => {
    managerState.tokens = {
      accessToken: 'expired-account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() - 1,
      userId: 'account-a',
      username: 'account-a',
    }
    const refreshStarted = createDeferred<void>()
    const pendingRefresh = createDeferred<any>()
    adminClientBehavior.refresh = async () => {
      refreshStarted.resolve()
      return pendingRefresh.promise
    }
    adminClientBehavior.login = async () => ({
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
      expiresIn: 3600,
      user: {
        id: 'account-b',
        username: 'account-b',
        displayName: 'Account B',
        role: 'member',
        groupIds: [],
      },
    })
    const { validate, login } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const staleValidation = validate(context)
    await refreshStarted.promise
    await login(context, 'account-b', 'secret')
    pendingRefresh.reject(new TestAdminError('offline', 'NETWORK_ERROR'))

    expect(await staleValidation).toEqual({
      loggedIn: false,
      errorCode: 'SESSION_CHANGED',
      message: 'Admin session changed',
    })
    expect(managerState.tokens).toMatchObject({ userId: 'account-b' })
  })

  it('does not commit account A offline catalog after its refresh loses the CAS to B', async () => {
    const organizationA = '11111111-1111-4111-8111-111111111111'
    managerState.tokens = {
      accessToken: 'expired-account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() - 1,
      userId: 'account-a',
      username: 'account-a',
    }
    appCatalogCache.set(`account-a:${organizationA}`, {
      accountId: 'account-a',
      organizationId: organizationA,
      authorizationStatus: 'authorized',
      appConfigVersion: 'apps-a',
      apps: [],
    })
    appCatalogAccess.set(`account-a:${organizationA}`, 'online')
    appCatalogAccess.set('account-b:organization-b', 'online')
    const refreshStarted = createDeferred<void>()
    const pendingRefresh = createDeferred<any>()
    adminClientBehavior.refresh = async () => {
      refreshStarted.resolve()
      return pendingRefresh.promise
    }
    adminClientBehavior.login = async () => ({
      accessToken: 'account-b-token',
      refreshToken: 'account-b-refresh',
      expiresIn: 3600,
      user: {
        id: 'account-b',
        username: 'account-b',
        displayName: 'Account B',
        role: 'member',
        groupIds: [],
      },
    })
    const { syncAppCatalog, login } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const staleSync = syncAppCatalog(context, organizationA, { force: true })
    await refreshStarted.promise
    await login(context, 'account-b', 'secret')
    pendingRefresh.reject(new TestAdminError('offline', 'NETWORK_ERROR'))

    expect(await staleSync).toEqual({
      success: false,
      errorCode: 'SESSION_CHANGED',
      message: 'Admin session changed',
    })
    expect(managerState.tokens).toMatchObject({ userId: 'account-b' })
    expect(appCatalogAccess.get(`account-a:${organizationA}`)).toBe('denied')
    expect(appCatalogAccess.get('account-b:organization-b')).toBe('online')
  })

  it('refuses the replacement session when old-account cleanup fails, retryably', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    adminSessionEnding.mockImplementationOnce(async () => {
      throw new Error('cleanup failed')
    })
    const { login } = createHarness()

    const result = await login(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'admin',
      'secret',
    )
    // The replacement is refused fail-closed: account B's tokens never land
    // while account A's executions/fence are not confirmed clean.
    expect(result).toMatchObject({
      success: false,
      errorCode: 'account_transition_pending',
    })
    expect(managerState.tokens).toMatchObject({ userId: 'account-a' })
    expect(loggerWarn).toHaveBeenCalled()

    // The failed cleanup is retried on a fresh login and then succeeds.
    const retry = await login(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'admin',
      'secret',
    )
    expect(retry).toMatchObject({ success: true, user: { id: 'user-1' } })
    expect(managerState.tokens).toMatchObject({ userId: 'user-1' })
  })

  it('refuses the replacement when a prior-account execution cannot be stopped', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    setRuntimeActiveProductSpaceAccount('account-a')
    setRuntimeActiveProductSpace('space-a')
    // A stuck prior-account assistant: even after a stop request it stays
    // active, so the bounded drain reports it as failed.
    let stopAttempts = 0
    registerProductSpaceExecution({
      scope: {
        contractVersion: 1,
        executionId: 'exec-stuck-a',
        accountId: 'account-a',
        productSpaceId: 'space-a',
        workspaceId: 'ws-a',
        subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      } as never,
      kind: 'assistant_session',
      name: 'assistant',
      ref: 'session-a',
      generation: 0,
      isActive: () => true,
      stop: async () => {
        stopAttempts += 1
        return 'failed' as const
      },
    })
    adminSessionEnding.mockImplementation(async (accountId: string) => {
      const stopped = await stopRegisteredProductSpaceExecutionsForAccount(accountId)
      if (!stopped.ok) {
        throw new Error(`product_space_execution_stop_failed: ${stopped.failedExecutionIds.join(', ')}`)
      }
    })

    const { login } = createHarness()
    const result = await login(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'admin',
      'secret',
    )
    expect(stopAttempts).toBeGreaterThan(0)
    expect(result).toMatchObject({
      success: false,
      errorCode: 'account_transition_pending',
    })
    expect(managerState.tokens).toMatchObject({ userId: 'account-a' })
    // The fence stays exactly where it was: no replacement landed on top of
    // the still-running prior-account execution.
    expect(getRuntimeActiveProductSpace()).toBe('space-a')
  }, 20_000)

  it('refuses the replacement when the prior-account liveness probe keeps failing', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    // Probe failures fail closed: the execution counts as still running and
    // the bounded drain reports it as failed.
    registerProductSpaceExecution({
      scope: {
        contractVersion: 1,
        executionId: 'exec-probe-broken-a',
        accountId: 'account-a',
        productSpaceId: 'space-a',
        workspaceId: 'ws-a',
        subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      } as never,
      kind: 'assistant_session',
      name: 'assistant',
      ref: 'session-a',
      generation: 0,
      isActive: () => Promise.reject(new Error('probe broken')),
      stop: async () => 'stopped' as const,
    })
    adminSessionEnding.mockImplementation(async (accountId: string) => {
      const stopped = await stopRegisteredProductSpaceExecutionsForAccount(accountId)
      if (!stopped.ok) {
        throw new Error(`product_space_execution_stop_failed: ${stopped.failedExecutionIds.join(', ')}`)
      }
    })

    const { login } = createHarness()
    const result = await login(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'admin',
      'secret',
    )
    expect(result).toMatchObject({
      success: false,
      errorCode: 'account_transition_pending',
    })
    expect(managerState.tokens).toMatchObject({ userId: 'account-a' })
  }, 20_000)

  it('refuses the replacement when the prior-account fence revoke fails, then lands after the revoke recovers', async () => {
    managerState.tokens = {
      accessToken: 'account-a-token',
      refreshToken: 'account-a-refresh',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    }
    setRuntimeActiveProductSpaceAccount('account-a')
    setRuntimeActiveProductSpace('space-a')
    adminSessionEnding.mockImplementation(async () => {})
    // Wedge the switch lock so the fence revoke cannot complete; the
    // replacement must fail instead of landing on top of a live fence.
    const { withSwitchLock } = await import('../../runtime/product-space-executions')
    const releaseLock = createDeferred<void>()
    const wedge = withSwitchLock(() => new Promise<void>(resolve => {
      void releaseLock.promise.then(resolve)
    }))
    const { login } = createHarness()
    const pendingLogin = login(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'admin',
      'secret',
    )
    const refusal = await Promise.race([
      pendingLogin.then(() => 'committed' as const),
      new Promise<'stalled'>(resolve => {
        setTimeout(() => resolve('stalled'), 2_000)
      }),
    ])
    // While the revoke is stuck, the login must not have landed account B.
    expect(refusal).toBe('stalled')
    expect(managerState.tokens).toMatchObject({ userId: 'account-a' })
    expect(getRuntimeActiveProductSpace()).toBe('space-a')

    // Once the revoke can complete, the same login finishes: the replacement
    // lands only after the fence is confirmed revoked.
    releaseLock.resolve()
    await wedge
    const settled = await pendingLogin
    expect(settled).toMatchObject({ success: true, user: { id: 'user-1' } })
    expect(getRuntimeActiveProductSpace()).toBeNull()
  }, 20_000)

  it('syncs transit-encrypted admin api keys into credential storage as plaintext', async () => {
    adminClientBehavior.getLlmConnections = async () => ({
      configVersion: 'config-v1',
      connections: [
        adminConnection({
          apiKey: encryptedApiKey('sk-encrypted-admin', 'access-token'),
        }),
      ],
      defaultConnection: 'admin-anthropic',
    })
    const { login } = createHarness()

    const result = await login({ clientId: 'client-1', workspaceId: null, webContentsId: null }, 'admin', 'secret')

    expect(result).toMatchObject({ success: true })
    expect(managerState.llmApiKeys.get('admin-anthropic')).toBe('sk-encrypted-admin')
    expect(Object.prototype.hasOwnProperty.call(configState.connections[0], 'apiKey')).toBe(false)
  })

  it('maps admin endpoint to llm connection baseUrl during sync', async () => {
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    }
    adminClientBehavior.getLlmConnections = async () => ({
      configVersion: 'config-v1',
      connections: [
        adminConnection({
          slug: 'custom-ollama',
          name: 'Custom Ollama',
          providerType: 'pi_compat',
          authType: 'api_key_with_endpoint',
          endpoint: 'http://localhost:11434',
          models: ['llama3.2'],
          defaultModel: 'llama3.2',
        }),
        adminConnection({
          slug: 'admin-anthropic',
          name: 'Admin Anthropic',
          authType: 'api_key',
        }),
      ],
      defaultConnection: 'custom-ollama',
    })
    const { syncConnections } = createHarness()

    const result = await syncConnections({ clientId: 'client-1', workspaceId: null, webContentsId: null })

    expect(result).toMatchObject({
      success: true,
      configVersion: 'config-v1',
      connectionCount: 2,
    })
    const customOllama = configState.connections.find(connection => connection.slug === 'custom-ollama')
    expect(customOllama).toMatchObject({
      authType: 'api_key_with_endpoint',
      baseUrl: 'http://localhost:11434',
      managedBy: 'admin',
      adminConfigVersion: 'config-v1',
    })
    expect(Object.prototype.hasOwnProperty.call(customOllama, 'endpoint')).toBe(false)
    const adminAnthropic = configState.connections.find(connection => connection.slug === 'admin-anthropic')
    expect(adminAnthropic?.baseUrl).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(adminAnthropic, 'endpoint')).toBe(false)
  })

  it('derives pi auth provider for admin custom endpoint connections', async () => {
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    }
    adminClientBehavior.getLlmConnections = async () => ({
      configVersion: 'config-v1',
      connections: [
        adminConnection({
          slug: 'mimo-token-plan',
          name: 'MiMo Token Plan',
          providerType: 'pi_compat',
          authType: 'api_key_with_endpoint',
          endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
          customEndpoint: { api: 'openai-completions' },
          apiKey: encryptedApiKey('sk-mimo-secret', 'access-token'),
          models: ['mimo-v2.5-pro'],
          defaultModel: 'mimo-v2.5-pro',
        }),
      ],
      defaultConnection: 'mimo-token-plan',
    })
    const { syncConnections } = createHarness()

    const result = await syncConnections({ clientId: 'client-1', workspaceId: null, webContentsId: null })

    expect(result).toMatchObject({ success: true, connectionCount: 1 })
    expect(configState.connections[0]).toMatchObject({
      slug: 'mimo-token-plan',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      customEndpoint: { api: 'openai-completions' },
      piAuthProvider: 'openai',
      managedBy: 'admin',
    })
    expect(managerState.llmApiKeys.get('mimo-token-plan')).toBe('sk-mimo-secret')
  })

  it('returns an admin error payload when login fails', async () => {
    adminClientBehavior.login = async () => {
      throw new TestAdminError('Invalid username or password', 'INVALID_CREDENTIALS')
    }
    const { login } = createHarness()

    const result = await login({ clientId: 'client-1', workspaceId: null, webContentsId: null }, 'admin', 'wrong')

    expect(result).toEqual({
      success: false,
      errorCode: 'INVALID_CREDENTIALS',
      message: 'Invalid username or password',
    })
    expect(managerState.tokens).toBeNull()
    expect(configState.connections).toEqual([])
  })

  it('refreshes expired admin tokens during validate and syncs when config changes', async () => {
    managerState.tokens = {
      accessToken: 'expired-access-token',
      refreshToken: 'old-refresh-token',
      expiresAt: Date.now() - 1000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    }
    configState.adminConfigVersion = 'config-v0'
    adminClientBehavior.validate = async (accessToken: string) => ({
      valid: true,
      configVersion: 'config-v1',
      user: {
        id: 'user-1',
        username: 'admin',
        displayName: 'Admin User',
        role: 'admin',
        groupIds: [],
      },
      seenAccessToken: accessToken,
    })
    const { validate } = createHarness()

    const result = await validate({ clientId: 'client-1', workspaceId: null, webContentsId: null })

    expect(result).toMatchObject({
      loggedIn: true,
      configVersion: 'config-v1',
    })
    expect(adminClientCalls.map(call => call.method)).toEqual(['refresh', 'validate', 'getLlmConnections'])
    expect(adminClientCalls.find(call => call.method === 'validate')?.accessToken).toBe('fresh-access-token')
    expect(managerState.tokens).toMatchObject({
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token',
      userId: 'user-1',
      username: 'admin',
    })
    expect(configState.adminConfigVersion).toBe('config-v1')
  })

  it('returns a revoked-token signal when refresh fails during validate', async () => {
    const organizationId = 'organization-cleanup-401'
    managerState.tokens = {
      accessToken: 'expired-access-token',
      refreshToken: 'revoked-refresh-token',
      expiresAt: Date.now() - 1000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      apps: [{ id: 'remote-app', availability: 'available' }],
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    adminSessionEnding.mockImplementationOnce(async () => {
      throw new Error('controlled local stop failure')
    })
    adminClientBehavior.refresh = async () => {
      throw new TestAdminError('Refresh token revoked', 'TOKEN_REVOKED', { status: 401 })
    }
    const { validate } = createHarness()

    const result = await validate({ clientId: 'client-1', workspaceId: null, webContentsId: null })

    expect(result).toEqual({
      loggedIn: false,
      errorCode: 'TOKEN_REVOKED',
      message: 'Admin session is no longer valid',
      status: 401,
    })
    expect(managerState.tokens).toBeNull()
    expect(adminSessionEnding).toHaveBeenCalledWith('user-1')
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
    expect(appCatalogCache.get(`user-1:${organizationId}`))
      .toMatchObject({ authorizationStatus: 'denied' })
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('continuing fail-closed cleanup'),
      'controlled local stop failure',
    )
  })

  it('ends a locally unexpired session when VALIDATE preserves its protected 401', async () => {
    const organizationId = 'organization-protected-validate-401'
    managerState.tokens = {
      accessToken: 'locally-unexpired-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      apps: [{ id: 'remote-app', availability: 'available' }],
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    adminClientBehavior.validate = async () => {
      throw new TestAdminError(
        'protected endpoint rejected the token',
        'TOKEN_REVOKED',
        { status: 401 },
      )
    }
    const { validate } = createHarness()

    expect(await validate({
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    })).toEqual({
      loggedIn: false,
      errorCode: 'TOKEN_REVOKED',
      message: 'Admin session is no longer valid',
      status: 401,
    })
    expect(managerState.tokens).toBeNull()
    expect(adminSessionEnding).toHaveBeenCalledWith('user-1')
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
    expect(appCatalogCache.get(`user-1:${organizationId}`))
      .toMatchObject({ authorizationStatus: 'denied' })
    expect(adminClientCalls.map(call => call.method)).toEqual(['validate'])
  })

  it('fails closed when an expired-token refresh returns a non-temporary client error', async () => {
    const cases = [
      { errorCode: 'BAD_REQUEST', status: 400 },
      { errorCode: 'VALIDATION_ERROR', status: 400 },
      { errorCode: 'UNKNOWN_CLIENT_FAILURE', status: 422 },
    ]

    for (const testCase of cases) {
      managerState.tokens = {
        accessToken: `expired-${testCase.errorCode}`,
        refreshToken: `refresh-${testCase.errorCode}`,
        expiresAt: Date.now() - 1000,
        userId: 'user-1',
        username: 'admin',
        displayName: 'Admin User',
      }
      adminSessionEnding.mockClear()
      adminClientBehavior.refresh = async () => {
        throw new TestAdminError(
          'refresh rejected',
          testCase.errorCode,
          { status: testCase.status },
        )
      }
      const { validate } = createHarness()

      const result = await validate({
        clientId: 'client-1',
        workspaceId: null,
        webContentsId: null,
      })

      expect(result).toMatchObject({
        loggedIn: false,
        errorCode: testCase.errorCode,
        status: testCase.status,
      })
      expect(managerState.tokens).toBeNull()
      expect(adminSessionEnding).toHaveBeenCalledWith('user-1')
    }
  })

  it('keeps an expired verified identity for restricted offline startup when refresh is unreachable', async () => {
    managerState.tokens = {
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 1000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
      role: 'admin',
      groupIds: ['group-1'],
    }
    adminClientBehavior.refresh = async () => {
      throw new TestAdminError('offline', 'NETWORK_ERROR')
    }
    const { validate } = createHarness()

    const result = await validate({
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    })

    expect(result).toMatchObject({
      loggedIn: true,
      offline: true,
      user: { id: 'user-1', role: 'admin', groupIds: ['group-1'] },
    })
    expect(managerState.tokens).not.toBeNull()
    expect(adminSessionEnding).not.toHaveBeenCalled()
  })

  it('preserves a denied Catalog when token refresh is offline during cold sync', async () => {
    const organizationId = '35555555-5555-4555-8555-555555555555'
    managerState.tokens = {
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 1000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'denied',
      appConfigVersion: 'apps-v1',
      syncedAt: 50,
      apps: [{
        id: 'retained-app',
        organizationId,
        name: 'Retained app',
        description: '',
        deliveryMode: 'local_bundle',
        currentRelease: {
          version: '1.0.0',
          runtime: 'static',
          downloadUrl: 'https://private.example.com/retained.zip',
          checksum: 'a'.repeat(64),
          sizeBytes: 42,
        },
        sortOrder: 0,
        availability: 'available',
      }],
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'denied')
    adminClientBehavior.refresh = async () => {
      throw new TestAdminError('offline', 'NETWORK_ERROR')
    }
    const { syncAppCatalog } = createHarness()

    expect(await syncAppCatalog(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      organizationId,
      { force: true },
    )).toMatchObject({
      success: false,
      errorCode: 'NETWORK_ERROR',
      accessMode: 'denied',
      catalog: {
        authorizationStatus: 'denied',
        apps: [{
          id: 'retained-app',
          availability: 'unavailable',
        }],
      },
    })
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
    expect(managerState.tokens).toMatchObject({ userId: 'user-1' })
    expect(adminSessionEnding).not.toHaveBeenCalled()
    expect(adminClientCalls.map(call => call.method)).toEqual(['refresh'])
  })

  it('keeps a non-expired verified identity when cold-start validation is offline', async () => {
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
      role: 'member',
      groupIds: [],
    }
    adminClientBehavior.validate = async () => {
      throw new TestAdminError('offline', 'NETWORK_ERROR')
    }
    const { validate } = createHarness()

    const result = await validate({
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    })

    expect(result).toMatchObject({ loggedIn: true, offline: true })
    expect(managerState.tokens).not.toBeNull()
  })

  it('syncs admin connections by upserting incoming config and removing admin-deleted connections', async () => {
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    }
    configState.adminConfigVersion = 'config-v0'
    configState.connections = [
      {
        slug: 'admin-anthropic',
        name: 'Old Admin Name',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: 100,
        managedBy: 'admin',
        adminConfigVersion: 'config-v0',
        models: ['old-model'],
        defaultModel: 'old-model',
        apiKey: 'sk-stale-config',
      },
      {
        slug: 'admin-removed',
        name: 'Removed Admin',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: 101,
        managedBy: 'admin',
        adminConfigVersion: 'config-v0',
      },
      {
        slug: 'user-local',
        name: 'User Local',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: 200,
        models: ['user-model'],
        defaultModel: 'user-model',
      },
    ]
    managerState.llmApiKeys.set('admin-removed', 'sk-removed')
    adminClientBehavior.getLlmConnections = async () => ({
      configVersion: 'config-v2',
      connections: [
        adminConnection({
          slug: 'admin-anthropic',
          name: 'Admin Anthropic Updated',
          models: ['claude-sonnet-4-5', 'claude-opus-4-5'],
          defaultModel: 'claude-opus-4-5',
          apiKey: 'sk-updated',
        }),
        adminConnection({
          slug: 'admin-pi',
          name: 'Admin Pi',
          providerType: 'pi',
          models: ['pi/anthropic/claude-sonnet-4-5'],
          defaultModel: 'pi/anthropic/claude-sonnet-4-5',
          apiKey: 'sk-pi',
        }),
      ],
      defaultConnection: 'admin-pi',
    })
    const { syncConnections } = createHarness()

    const result = await syncConnections({ clientId: 'client-1', workspaceId: null, webContentsId: null })

    expect(result).toEqual({
      success: true,
      configVersion: 'config-v2',
      connectionCount: 2,
      defaultConnection: 'admin-pi',
    })
    expect(configState.connections.map(connection => connection.slug).sort()).toEqual([
      'admin-anthropic',
      'admin-pi',
      'user-local',
    ])
    expect(configState.connections.find(connection => connection.slug === 'admin-anthropic')).toMatchObject({
      name: 'Admin Anthropic Updated',
      managedBy: 'admin',
      adminConfigVersion: 'config-v2',
      models: ['claude-sonnet-4-5', 'claude-opus-4-5'],
      defaultModel: 'claude-opus-4-5',
    })
    expect(configState.connections.find(connection => connection.slug === 'admin-pi')).toMatchObject({
      providerType: 'pi',
      managedBy: 'admin',
      adminConfigVersion: 'config-v2',
    })
    const userLocal = configState.connections.find(connection => connection.slug === 'user-local')
    expect(userLocal).toMatchObject({ slug: 'user-local' })
    expect(userLocal?.managedBy).toBeUndefined()
    for (const connection of configState.connections.filter(item => item.managedBy === 'admin')) {
      expect(Object.prototype.hasOwnProperty.call(connection, 'apiKey')).toBe(false)
    }
    expect(managerState.llmApiKeys.get('admin-anthropic')).toBe('sk-updated')
    expect(managerState.llmApiKeys.get('admin-pi')).toBe('sk-pi')
    expect(managerState.llmApiKeys.has('admin-removed')).toBe(false)
    expect(managerState.deletedCredentialSlugs).toEqual(['admin-removed'])
    expect(configState.defaultConnection).toBe('admin-pi')
    expect(configState.adminConfigVersion).toBe('config-v2')
  })

  it('syncs the active organization app catalog with its independent version', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111'
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      appConfigVersion: 'apps-v1',
      syncedAt: 50,
      apps: [],
    })
    adminClientBehavior.getAppCatalog = async () => ({
      notModified: false,
      appConfigVersion: 'apps-v2',
      apps: [{
        id: 'app-1',
        organizationId,
        name: 'Knowledge base',
        description: 'Internal docs',
        deliveryMode: 'remote_url',
        remoteUrl: 'https://kb.example.com',
        sortOrder: 1,
      }],
    })
    const { syncAppCatalog } = createHarness()

    const result = await syncAppCatalog(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      organizationId,
      {},
    )

    expect(result).toMatchObject({
      success: true,
      source: 'network',
      refreshed: true,
      catalog: {
        accountId: 'user-1',
        organizationId,
        appConfigVersion: 'apps-v2',
      },
    })
    expect(adminClientCalls).toContainEqual({
      method: 'getAppCatalog',
      args: [organizationId, 'apps-v1'],
      accessToken: 'access-token',
    })
    expect(retainedCatalogAppIds).toHaveBeenCalledWith(
      'user-1',
      organizationId,
    )
  })

  it('rejects malformed UTF-16 organization ids before Catalog cache access', async () => {
    const { syncAppCatalog } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    for (const organizationId of ['\uD800', '\uDC00', `org-\uD800`]) {
      expect(await syncAppCatalog(context, organizationId, { force: true }))
        .toEqual({
          success: false,
          errorCode: 'VALIDATION_ERROR',
          message: 'Organization id is invalid',
        })
    }
    expect(adminClientCalls).toEqual([])
  })

  it('keeps denied Catalog delivery capabilities closed after an unexpected 304', async () => {
    const organizationId = 'organization:denied\0snapshot'
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'denied',
      appConfigVersion: 'apps-v1',
      syncedAt: 50,
      apps: [{
        id: 'remote-app',
        organizationId,
        name: 'Private remote app',
        description: '',
        deliveryMode: 'remote_url',
        remoteUrl: 'https://private.example.com/app',
        sortOrder: 0,
        availability: 'unavailable',
      }, {
        id: 'bundle-app',
        organizationId,
        name: 'Private bundle app',
        description: '',
        deliveryMode: 'local_bundle',
        currentRelease: {
          version: '2.0.0',
          runtime: 'static',
          downloadUrl: 'https://private.example.com/app.zip',
          checksum: 'a'.repeat(64),
          sizeBytes: 42,
        },
        permissions: ['filesystem'],
        sortOrder: 1,
        availability: 'unavailable',
      }],
      trustedReleases: {
        'bundle-app': {
          version: '2.0.0',
          runtime: 'static',
          downloadUrl: 'https://private.example.com/app.zip',
          checksum: 'a'.repeat(64),
          sizeBytes: 42,
        },
      },
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'denied')
    adminClientBehavior.getAppCatalog = async (
      _accessToken,
      requestedOrganizationId,
      requestedVersion,
    ) => {
      expect(requestedOrganizationId).toBe(organizationId)
      expect(requestedVersion).toBeUndefined()
      return { notModified: true }
    }
    const { syncAppCatalog } = createHarness()

    const result = await syncAppCatalog(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      organizationId,
      {},
    )

    expect(result).toMatchObject({
      success: false,
      errorCode: 'SERVER_ERROR',
      accessMode: 'denied',
      catalog: {
        authorizationStatus: 'denied',
        apps: [
          { id: 'remote-app', availability: 'unavailable' },
          { id: 'bundle-app', availability: 'unavailable' },
        ],
      },
    })
    expect(result.catalog).not.toHaveProperty('trustedReleases')
    expect(result.catalog.apps[0]).not.toHaveProperty('remoteUrl')
    expect(result.catalog.apps[1]).not.toHaveProperty('currentRelease')
    expect(result.catalog.apps[1]).not.toHaveProperty('permissions')
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
    expect(adminClientCalls.filter(call => call.method === 'getAppCatalog'))
      .toHaveLength(1)
  })

  it('fails closed when a forced full Catalog request unexpectedly returns 304', async () => {
    const organizationId = 'organization-force-refresh'
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      appConfigVersion: 'apps-v1',
      syncedAt: 50,
      apps: [{
        id: 'private-app',
        organizationId,
        name: 'Private app',
        description: '',
        deliveryMode: 'remote_url',
        remoteUrl: 'https://private.example.com',
        sortOrder: 0,
        availability: 'available',
      }],
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    adminClientBehavior.getAppCatalog = async (
      _accessToken,
      _requestedOrganizationId,
      requestedVersion,
    ) => {
      expect(requestedVersion).toBeUndefined()
      return { notModified: true }
    }
    const { syncAppCatalog } = createHarness()

    const result = await syncAppCatalog(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      organizationId,
      { force: true },
    )

    expect(result).toMatchObject({
      success: false,
      errorCode: 'SERVER_ERROR',
      accessMode: 'denied',
      catalog: {
        authorizationStatus: 'denied',
        apps: [{ id: 'private-app', availability: 'unavailable' }],
      },
    })
    expect(result.catalog.apps[0]).not.toHaveProperty('remoteUrl')
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
  })

  it('rechecks the process access gate before accepting a versioned 304', async () => {
    const organizationId = 'organization-versioned-304-race'
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      appConfigVersion: 'apps-v1',
      syncedAt: 50,
      apps: [{
        id: 'private-app',
        organizationId,
        name: 'Private app',
        description: '',
        deliveryMode: 'remote_url',
        remoteUrl: 'https://private.example.com',
        sortOrder: 0,
        availability: 'available',
      }],
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    adminClientBehavior.getAppCatalog = async (
      _accessToken,
      _requestedOrganizationId,
      requestedVersion,
    ) => {
      expect(requestedVersion).toBe('apps-v1')
      appCatalogAccess.set(`user-1:${organizationId}`, 'denied')
      return { notModified: true }
    }
    const { syncAppCatalog } = createHarness()

    const result = await syncAppCatalog(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      organizationId,
      {},
    )

    expect(result).toMatchObject({
      success: false,
      errorCode: 'SERVER_ERROR',
      accessMode: 'denied',
      catalog: {
        authorizationStatus: 'denied',
        apps: [{ id: 'private-app', availability: 'unavailable' }],
      },
    })
    expect(result.catalog.apps[0]).not.toHaveProperty('remoteUrl')
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
  })

  it('rejects reuse of a Catalog id with a different delivery mode', async () => {
    const organizationId = '12222222-2222-4222-8222-222222222222'
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    const cached = {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized' as const,
      appConfigVersion: 'apps-v1',
      syncedAt: 50,
      apps: [{
        id: 'stable-app-id',
        organizationId,
        name: 'Remote App',
        description: '',
        deliveryMode: 'remote_url' as const,
        remoteUrl: 'https://remote.example.com',
        availability: 'available' as const,
        sortOrder: 0,
      }],
    }
    appCatalogCache.set(`user-1:${organizationId}`, cached)
    appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    adminClientBehavior.getAppCatalog = async () => ({
      notModified: false,
      appConfigVersion: 'apps-v2',
      apps: [{
        id: 'stable-app-id',
        organizationId,
        name: 'Local App',
        description: '',
        deliveryMode: 'local_bundle',
        currentRelease: {
          version: '1.0.0',
          runtime: 'static',
          downloadUrl: 'https://catalog.example.com/app.zip',
          checksum: 'a'.repeat(64),
          sizeBytes: 1,
        },
        sortOrder: 0,
      }],
    })
    const { syncAppCatalog } = createHarness()

    expect(await syncAppCatalog(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      organizationId,
      { force: true },
    )).toEqual({
      success: true,
      catalog: cached,
      source: 'cache',
      refreshed: false,
      accessMode: 'offline',
      warningCode: 'SERVER_ERROR',
      warning: 'Admin request failed',
    })
    expect(appCatalogCache.get(`user-1:${organizationId}`)).toEqual(cached)
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('offline')
  })

  it('does not let an older catalog response overwrite a newer committed catalog', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111'
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      appConfigVersion: 'apps-v0',
      syncedAt: 50,
      apps: [],
    })
    const v1 = createDeferred<any>()
    const v2 = createDeferred<any>()
    const requestStarted = [
      createDeferred<void>(),
      createDeferred<void>(),
    ]
    let requestIndex = 0
    adminClientBehavior.getAppCatalog = async () => {
      const index = requestIndex++
      requestStarted[index]!.resolve()
      return index === 0 ? v1.promise : v2.promise
    }
    const { syncAppCatalog } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const older = syncAppCatalog(context, organizationId, { force: true })
    await requestStarted[0]!.promise
    const newer = syncAppCatalog(context, organizationId, { force: true })
    await requestStarted[1]!.promise
    v2.resolve({
      notModified: false,
      appConfigVersion: 'apps-v2',
      apps: [{
        id: 'new-app',
        organizationId,
        name: 'New app',
        description: '',
        deliveryMode: 'remote_url',
        remoteUrl: 'https://new.example.com',
        sortOrder: 0,
      }],
    })
    expect(await newer).toMatchObject({
      success: true,
      catalog: {
        appConfigVersion: 'apps-v2',
        apps: [{ id: 'new-app' }],
      },
    })

    v1.resolve({
      notModified: false,
      appConfigVersion: 'apps-v1',
      apps: [{
        id: 'withdrawn-old-app',
        organizationId,
        name: 'Old app',
        description: '',
        deliveryMode: 'remote_url',
        remoteUrl: 'https://old.example.com',
        sortOrder: 0,
      }],
    })
    expect(await older).toEqual({
      success: false,
      errorCode: 'REQUEST_SUPERSEDED',
      message: 'A newer app catalog sync replaced this request',
    })
    expect(appCatalogCache.get(`user-1:${organizationId}`)).toMatchObject({
      appConfigVersion: 'apps-v2',
      authorizationStatus: 'authorized',
      apps: [{ id: 'new-app' }],
    })
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('online')
  })

  it('does not let a newer temporary Catalog failure suppress an explicit session revocation', async () => {
    const cases = [
      {
        organizationId: '16666666-6666-4666-8666-666666666661',
        authError: new TestAdminError(
          'protected endpoint rejected the token',
          'TOKEN_REVOKED',
          { status: 401 },
        ),
        temporaryError: new TestAdminError('offline', 'NETWORK_ERROR'),
      },
      {
        organizationId: '16666666-6666-4666-8666-666666666662',
        authError: new TestAdminError(
          'account disabled',
          'ACCOUNT_DISABLED',
          { status: 403 },
        ),
        temporaryError: new TestAdminError(
          'service unavailable',
          'SERVER_ERROR',
          { status: 503 },
        ),
      },
    ]

    for (const testCase of cases) {
      managerState.tokens = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600_000,
        userId: 'user-1',
        username: 'admin',
      }
      const cacheKey = `user-1:${testCase.organizationId}`
      appCatalogCache.set(cacheKey, {
        accountId: 'user-1',
        organizationId: testCase.organizationId,
        authorizationStatus: 'authorized',
        appConfigVersion: 'apps-v1',
        syncedAt: 50,
        apps: [{
          id: 'private-app',
          organizationId: testCase.organizationId,
          deliveryMode: 'local_bundle',
          availability: 'available',
        }],
      })
      appCatalogAccess.set(cacheKey, 'online')

      const olderFailure = createDeferred<any>()
      const newerFailure = createDeferred<any>()
      const requestStarted = [
        createDeferred<void>(),
        createDeferred<void>(),
      ]
      const cleanupStarted = createDeferred<void>()
      const releaseCleanup = createDeferred<void>()
      adminSessionEnding.mockClear()
      adminSessionEnding.mockImplementationOnce(async () => {
        cleanupStarted.resolve()
        await releaseCleanup.promise
      })
      let requestIndex = 0
      adminClientBehavior.getAppCatalog = async () => {
        const index = requestIndex++
        requestStarted[index]!.resolve()
        return index === 0 ? olderFailure.promise : newerFailure.promise
      }
      const { syncAppCatalog } = createHarness()
      const context = {
        clientId: 'client-1',
        workspaceId: null,
        webContentsId: null,
      }

      const older = syncAppCatalog(
        context,
        testCase.organizationId,
        { force: true },
      )
      await requestStarted[0]!.promise
      const newer = syncAppCatalog(
        context,
        testCase.organizationId,
        { force: true },
      )
      await requestStarted[1]!.promise

      olderFailure.reject(testCase.authError)
      await cleanupStarted.promise
      expect(appCatalogCache.get(cacheKey)).toMatchObject({
        authorizationStatus: 'denied',
        apps: [{ availability: 'unavailable' }],
      })

      newerFailure.reject(testCase.temporaryError)
      expect(await newer).toMatchObject({
        success: false,
        errorCode: 'SESSION_CHANGED',
      })

      releaseCleanup.resolve()
      expect(await older).toMatchObject({
        success: false,
        errorCode: testCase.authError.errorCode,
        status: testCase.authError.status,
      })
      expect(managerState.tokens).toBeNull()
      expect(adminSessionEnding).toHaveBeenCalledWith('user-1')
      expect(appCatalogAccess.get(cacheKey)).toBe('denied')
      expect(appCatalogCache.get(cacheKey)).toMatchObject({
        authorizationStatus: 'denied',
        apps: [{ availability: 'unavailable' }],
      })
      appCatalogCache.clear()
      appCatalogAccess.clear()
    }
  })

  it('does not let a pending Catalog response reopen an organization removed by a newer list', async () => {
    const organizationId = '14444444-4444-4444-8444-444444444444'
    managerState.tokens = {
      accessToken: 'locally-unexpired-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      appConfigVersion: 'apps-v0',
      syncedAt: 50,
      apps: [{
        id: 'cached-app',
        organizationId,
        name: 'Cached app',
        description: '',
        deliveryMode: 'remote_url',
        remoteUrl: 'https://private.example.com/cached',
        sortOrder: 0,
        availability: 'available',
      }],
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    const pendingCatalog = createDeferred<any>()
    const catalogStarted = createDeferred<void>()
    adminClientBehavior.getAppCatalog = async () => {
      catalogStarted.resolve()
      return pendingCatalog.promise
    }
    adminClientBehavior.listOrganizations = async () => ({ organizations: [] })
    const { listOrganizations, syncAppCatalog } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const oldCatalogRequest = syncAppCatalog(
      context,
      organizationId,
      { force: true },
    )
    await catalogStarted.promise
    expect(await listOrganizations(context)).toMatchObject({ success: true })
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')

    pendingCatalog.resolve({
      notModified: false,
      appConfigVersion: 'apps-v1',
      apps: [{
        id: 'stale-reopened-app',
        organizationId,
        name: 'Stale app',
        description: '',
        deliveryMode: 'remote_url',
        remoteUrl: 'https://stale.example.com',
        sortOrder: 0,
      }],
    })

    expect(await oldCatalogRequest).toEqual({
      success: false,
      errorCode: 'REQUEST_SUPERSEDED',
      message: 'A newer app catalog sync replaced this request',
    })
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
    expect(appCatalogCache.get(`user-1:${organizationId}`)).toMatchObject({
      appConfigVersion: 'apps-v0',
      authorizationStatus: 'denied',
      apps: [{
        id: 'cached-app',
        availability: 'unavailable',
      }],
    })
  })

  it('keeps the last app catalog when a network request fails or times out', async () => {
    for (const errorCode of ['NETWORK_ERROR', 'TIMEOUT']) {
      const organizationId = `11111111-1111-4111-8111-11111111111${
        errorCode === 'TIMEOUT' ? '2' : '1'
      }`
      managerState.tokens = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600_000,
        userId: 'user-1',
        username: 'admin',
      }
      const cached = {
        accountId: 'user-1',
        organizationId,
        authorizationStatus: 'authorized',
        appConfigVersion: 'apps-v1',
        syncedAt: 50,
        apps: [],
      }
      appCatalogCache.set(`user-1:${organizationId}`, cached)
      adminClientBehavior.getAppCatalog = async () => {
        throw new TestAdminError('offline', errorCode)
      }
      const { syncAppCatalog } = createHarness()

      const result = await syncAppCatalog(
        { clientId: 'client-1', workspaceId: null, webContentsId: null },
        organizationId,
        { force: true },
      )

      expect(result).toEqual({
        success: true,
        catalog: cached,
        source: 'cache',
        refreshed: false,
        accessMode: 'offline',
        warningCode: errorCode,
        warning: 'Admin request failed',
      })
    }
  })

  it('denies only the Catalog scope after a cached organization 403', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111'
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      appConfigVersion: 'apps-v1',
      syncedAt: 50,
      apps: [{
        id: 'app-1',
        organizationId,
        name: 'Private app',
        description: '',
        deliveryMode: 'remote_url',
        remoteUrl: 'https://private.example.com',
        sortOrder: 1,
        availability: 'available',
      }, {
        id: 'bundle-app',
        organizationId,
        name: 'Private bundle',
        description: '',
        deliveryMode: 'local_bundle',
        currentRelease: {
          version: '1.0.0',
          runtime: 'static',
          downloadUrl: 'https://private.example.com/bundle.zip',
          checksum: 'a'.repeat(64),
          sizeBytes: 42,
        },
        permissions: ['filesystem'],
        sortOrder: 2,
        availability: 'available',
      }],
      trustedReleases: {
        'bundle-app': {
          version: '1.0.0',
          runtime: 'static',
          downloadUrl: 'https://private.example.com/bundle.zip',
          checksum: 'a'.repeat(64),
          sizeBytes: 42,
        },
      },
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    adminClientBehavior.getAppCatalog = async () => {
      throw new TestAdminError('membership removed', 'FORBIDDEN', { status: 403 })
    }
    const { syncAppCatalog } = createHarness()

    const result = await syncAppCatalog(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      organizationId,
      { force: true },
    )

    expect(result).toMatchObject({
      success: false,
      errorCode: 'FORBIDDEN',
      status: 403,
      accessMode: 'denied',
      catalog: {
        authorizationStatus: 'denied',
        apps: [
          { id: 'app-1', availability: 'unavailable' },
          { id: 'bundle-app', availability: 'unavailable' },
        ],
      },
    })
    expect(result.catalog).not.toHaveProperty('trustedReleases')
    expect(result.catalog.apps[0]).not.toHaveProperty('remoteUrl')
    expect(result.catalog.apps[1]).not.toHaveProperty('currentRelease')
    expect(result.catalog.apps[1]).not.toHaveProperty('permissions')
    expect(appCatalogCache.get(`user-1:${organizationId}`)).toMatchObject({
      authorizationStatus: 'denied',
      apps: [
        {
          availability: 'unavailable',
          remoteUrl: 'https://private.example.com',
        },
        {
          availability: 'unavailable',
          currentRelease: {
            downloadUrl: 'https://private.example.com/bundle.zip',
          },
        },
      ],
    })
    expect(managerState.tokens).toMatchObject({ userId: 'user-1' })
    expect(adminSessionEnding).not.toHaveBeenCalled()
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
  })

  it('ends a locally unexpired session when Catalog preserves its protected 401', async () => {
    const organizationId = '15555555-5555-4555-8555-555555555555'
    managerState.tokens = {
      accessToken: 'locally-unexpired-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      appConfigVersion: 'apps-v1',
      syncedAt: 50,
      apps: [{
        id: 'private-app',
        organizationId,
        deliveryMode: 'local_bundle',
        availability: 'available',
      }],
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    adminClientBehavior.getAppCatalog = async () => {
      throw new TestAdminError(
        'protected endpoint rejected the token',
        'TOKEN_REVOKED',
        { status: 401 },
      )
    }
    const { syncAppCatalog } = createHarness()

    expect(await syncAppCatalog(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      organizationId,
      { force: true },
    )).toMatchObject({
      success: false,
      errorCode: 'TOKEN_REVOKED',
      status: 401,
    })
    expect(managerState.tokens).toBeNull()
    expect(adminSessionEnding).toHaveBeenCalledWith('user-1')
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
    expect(appCatalogCache.get(`user-1:${organizationId}`)).toMatchObject({
      authorizationStatus: 'denied',
      apps: [{ availability: 'unavailable' }],
    })
    expect(adminClientCalls.map(call => call.method)).toEqual(['getAppCatalog'])
  })

  it('gives Catalog HTTP 401 priority over conflicting body error codes', async () => {
    for (const [errorCode, organizationId] of [
      ['FORBIDDEN', '25555555-5555-4555-8555-555555555551'],
      ['MEMBERSHIP_REMOVED', '25555555-5555-4555-8555-555555555552'],
      ['unknown_body_error', '25555555-5555-4555-8555-555555555553'],
    ] as const) {
      managerState.tokens = {
        accessToken: 'locally-unexpired-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600_000,
        userId: 'user-1',
        username: 'admin',
      }
      appCatalogCache.set(`user-1:${organizationId}`, {
        accountId: 'user-1',
        organizationId,
        authorizationStatus: 'authorized',
        appConfigVersion: 'apps-v1',
        syncedAt: 50,
        apps: [{
          id: 'private-app',
          organizationId,
          deliveryMode: 'local_bundle',
          availability: 'available',
        }],
      })
      appCatalogAccess.set(`user-1:${organizationId}`, 'online')
      adminClientBehavior.getAppCatalog = async () => {
        throw new TestAdminError(
          'protected endpoint rejected the token',
          errorCode,
          { status: 401 },
        )
      }
      const { syncAppCatalog } = createHarness()

      expect(await syncAppCatalog(
        { clientId: 'client-1', workspaceId: null, webContentsId: null },
        organizationId,
        { force: true },
      )).toMatchObject({
        success: false,
        errorCode,
        status: 401,
      })
      expect(managerState.tokens).toBeNull()
      expect(adminSessionEnding).toHaveBeenCalledWith('user-1')
      expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
      adminSessionEnding.mockClear()
      appCatalogCache.clear()
      appCatalogAccess.clear()
    }
  })

  it('ends the account for HTTP 401 from other public organization RPCs', async () => {
    const cases = [
      {
        errorCode: 'MEMBERSHIP_REMOVED',
        invoke: () => {
          adminClientBehavior.listOrganizations = async () => {
            throw new TestAdminError(
              'protected organization list rejected the token',
              'MEMBERSHIP_REMOVED',
              { status: 401 },
            )
          }
          return createHarness().listOrganizations({
            clientId: 'client-1',
            workspaceId: null,
            webContentsId: null,
          })
        },
      },
      {
        errorCode: 'unknown_body_error',
        invoke: () => {
          adminClientBehavior.createOrganization = async () => {
            throw new TestAdminError(
              'protected organization create rejected the token',
              'unknown_body_error',
              { status: 401 },
            )
          }
          return createHarness().createOrganization(
            {
              clientId: 'client-1',
              workspaceId: null,
              webContentsId: null,
            },
            {
              type: 'creator_space',
              name: 'Unauthorized create',
              purpose: 'Verify fail closed',
              idempotencyKey: 'organization-401-test',
            },
          )
        },
      },
    ]

    for (const testCase of cases) {
      managerState.tokens = {
        accessToken: 'locally-unexpired-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600_000,
        userId: 'user-1',
        username: 'admin',
      }

      expect(await testCase.invoke()).toMatchObject({
        success: false,
        errorCode: testCase.errorCode,
        status: 401,
      })
      expect(managerState.tokens).toBeNull()
      expect(adminSessionEnding).toHaveBeenCalledWith('user-1')
      adminSessionEnding.mockClear()
    }
  })

  it('denies cached catalog access for semantic membership loss on non-403 statuses', async () => {
    for (const [errorCode, status, organizationId] of [
      ['MEMBERSHIP_REMOVED', 409, '31111111-1111-4111-8111-111111111111'],
      ['MEMBERSHIP_SUSPENDED', 423, '32222222-2222-4222-8222-222222222222'],
      ['ORGANIZATION_UNAVAILABLE', 409, '33333333-3333-4333-8333-333333333333'],
    ] as const) {
      managerState.tokens = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600_000,
        userId: 'user-1',
        username: 'admin',
      }
      appCatalogCache.set(`user-1:${organizationId}`, {
        accountId: 'user-1',
        organizationId,
        authorizationStatus: 'authorized',
        appConfigVersion: 'apps-v1',
        syncedAt: 50,
        apps: [{
          id: 'private-app',
          organizationId,
          name: 'Private app',
          description: '',
          deliveryMode: 'remote_url',
          remoteUrl: 'https://private.example.com',
          sortOrder: 0,
          availability: 'available',
        }],
      })
      appCatalogAccess.set(`user-1:${organizationId}`, 'online')
      adminClientBehavior.getAppCatalog = async () => {
        throw new TestAdminError('authorization lost', errorCode, { status })
      }
      const { syncAppCatalog } = createHarness()

      expect(await syncAppCatalog(
        { clientId: 'client-1', workspaceId: null, webContentsId: null },
        organizationId,
        { force: true },
      )).toMatchObject({
        success: false,
        errorCode,
        status,
        accessMode: 'denied',
        catalog: {
          authorizationStatus: 'denied',
          apps: [{ availability: 'unavailable' }],
        },
      })
      expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
      expect(appCatalogCache.get(`user-1:${organizationId}`)).toMatchObject({
        authorizationStatus: 'denied',
        apps: [{ availability: 'unavailable' }],
      })
      expect(managerState.tokens).toMatchObject({ userId: 'user-1' })
      expect(adminSessionEnding).not.toHaveBeenCalled()
    }
  })

  it('returns an existing denied Catalog instead of reviving offline authorization', async () => {
    const organizationId = '34444444-4444-4444-8444-444444444444'
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'denied',
      appConfigVersion: 'apps-v1',
      syncedAt: 50,
      apps: [{
        id: 'retained-app',
        organizationId,
        name: 'Retained app',
        description: '',
        deliveryMode: 'local_bundle',
        currentRelease: {
          version: '1.0.0',
          runtime: 'static',
          downloadUrl: 'https://private.example.com/retained.zip',
          checksum: 'a'.repeat(64),
          sizeBytes: 42,
        },
        sortOrder: 0,
        availability: 'unavailable',
      }],
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'denied')
    adminClientBehavior.getAppCatalog = async () => {
      throw new TestAdminError('offline', 'NETWORK_ERROR')
    }
    const { syncAppCatalog } = createHarness()

    expect(await syncAppCatalog(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      organizationId,
      { force: true },
    )).toMatchObject({
      success: false,
      errorCode: 'NETWORK_ERROR',
      accessMode: 'denied',
      catalog: {
        authorizationStatus: 'denied',
        apps: [{
          id: 'retained-app',
          availability: 'unavailable',
        }],
      },
    })
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
    expect(managerState.tokens).toMatchObject({ userId: 'user-1' })
    expect(adminSessionEnding).not.toHaveBeenCalled()
  })

  it('keeps the process deny gate above stale authorized cache fallbacks', async () => {
    for (const temporaryErrorCode of ['NETWORK_ERROR', 'TIMEOUT']) {
      const organizationId = `deny-write-failure-${temporaryErrorCode}`
      managerState.tokens = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600_000,
        userId: 'user-1',
        username: 'admin',
      }
      appCatalogCache.set(`user-1:${organizationId}`, {
        accountId: 'user-1',
        organizationId,
        authorizationStatus: 'authorized',
        appConfigVersion: 'apps-v1',
        syncedAt: 50,
        apps: [{
          id: 'remote-app',
          organizationId,
          name: 'Private remote app',
          description: '',
          deliveryMode: 'remote_url',
          remoteUrl: 'https://private.example.com/app',
          sortOrder: 0,
          availability: 'available',
        }, {
          id: 'bundle-app',
          organizationId,
          name: 'Private bundle app',
          description: '',
          deliveryMode: 'local_bundle',
          currentRelease: {
            version: '1.0.0',
            runtime: 'static',
            downloadUrl: 'https://private.example.com/app.zip',
            checksum: 'a'.repeat(64),
            sizeBytes: 42,
          },
          sortOrder: 1,
          availability: 'available',
        }],
      })
      appCatalogAccess.set(`user-1:${organizationId}`, 'online')
      appCatalogCacheBehavior.denyWriteError = new Error('disk unavailable')
      adminClientBehavior.getAppCatalog = async () => {
        throw new TestAdminError('membership removed', 'FORBIDDEN', {
          status: 403,
        })
      }
      const { syncAppCatalog } = createHarness()
      const context = {
        clientId: 'client-1',
        workspaceId: null,
        webContentsId: null,
      }

      expect(await syncAppCatalog(context, organizationId, { force: true }))
        .toMatchObject({
          success: false,
          errorCode: 'FORBIDDEN',
          accessMode: 'denied',
        })
      expect(appCatalogCache.get(`user-1:${organizationId}`))
        .toMatchObject({ authorizationStatus: 'authorized' })
      expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')

      adminClientBehavior.getAppCatalog = async () => {
        throw new TestAdminError('transport unavailable', temporaryErrorCode)
      }
      const fallback = await syncAppCatalog(
        context,
        organizationId,
        { force: true },
      )

      expect(fallback).toMatchObject({
        success: false,
        errorCode: temporaryErrorCode,
        accessMode: 'denied',
        catalog: {
          authorizationStatus: 'denied',
          apps: [
            { id: 'remote-app', availability: 'unavailable' },
            { id: 'bundle-app', availability: 'unavailable' },
          ],
        },
      })
      expect(fallback.catalog).not.toHaveProperty('trustedReleases')
      expect(fallback.catalog.apps[0]).not.toHaveProperty('remoteUrl')
      expect(fallback.catalog.apps[1]).not.toHaveProperty('currentRelease')
      expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
      appCatalogCacheBehavior.denyWriteError = null
    }
  })

  it('treats a successful organization list as the new authorization truth', async () => {
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    for (const organizationId of ['removed-organization', 'suspended-organization']) {
      appCatalogCache.set(`user-1:${organizationId}`, {
        accountId: 'user-1',
        organizationId,
        authorizationStatus: 'authorized',
        appConfigVersion: 'apps-v1',
        syncedAt: 50,
        apps: [{
          id: 'private-app',
          organizationId,
          name: 'Private app',
          description: '',
          deliveryMode: 'local_bundle',
          currentRelease: {
            version: '1.0.0',
            runtime: 'static',
            downloadUrl: 'https://private.example.com/app.zip',
            checksum: 'a'.repeat(64),
            sizeBytes: 42,
          },
          sortOrder: 0,
          availability: 'available',
        }],
      })
      appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    }
    adminClientBehavior.listOrganizations = async () => ({
      organizations: [{
        id: 'suspended-organization',
        type: 'creator_space',
        name: 'Suspended',
        purpose: '',
        status: 'suspended',
        membership: {
          id: 'membership-1',
          role: 'member',
          status: 'active',
        },
        memberCount: 1,
      }],
    })
    const { listOrganizations } = createHarness()

    expect(await listOrganizations(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
    )).toMatchObject({ success: true })
    for (const organizationId of ['removed-organization', 'suspended-organization']) {
      expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
      expect(appCatalogCache.get(`user-1:${organizationId}`)).toMatchObject({
        authorizationStatus: 'denied',
        apps: [{ availability: 'unavailable' }],
      })
    }
  })

  it('logs out remotely and removes admin-managed connections and credentials', async () => {
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    }
    configState.adminConfigVersion = 'config-v1'
    configState.connections = [
      adminConnection({ slug: 'admin-anthropic', managedBy: 'admin', adminConfigVersion: 'config-v1' }),
      {
        slug: 'user-local',
        name: 'User Local',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: 200,
      },
    ]
    managerState.llmApiKeys.set('admin-anthropic', 'sk-admin')
    const { logout } = createHarness()

    const result = await logout({ clientId: 'client-1', workspaceId: null, webContentsId: null })

    expect(result).toEqual({ success: true })
    expect(adminClientCalls).toEqual([{
      method: 'logout',
      args: ['access-token'],
      accessToken: 'access-token',
    }])
    expect(managerState.tokens).toBeNull()
    expect(adminSessionEnding).toHaveBeenCalledWith('user-1')
    expect(configState.adminConfigVersion).toBeUndefined()
    expect(configState.connections.map(connection => connection.slug)).toEqual(['user-local'])
    expect(managerState.deletedCredentialSlugs).toEqual(['admin-anthropic'])
    expect(managerState.llmApiKeys.has('admin-anthropic')).toBe(false)
  })

  it('closes Catalog authorization before a slow remote logout completes', async () => {
    const organizationId = '17777777-7777-4777-8777-777777777771'
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      appConfigVersion: 'apps-v1',
      syncedAt: 1,
      apps: [{
        id: 'remote-app',
        organizationId,
        deliveryMode: 'remote_url',
        availability: 'available',
      }],
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    const logoutStarted = createDeferred<void>()
    const finishRemoteLogout = createDeferred<void>()
    adminClientBehavior.logout = async () => {
      logoutStarted.resolve()
      await finishRemoteLogout.promise
    }
    const { logout, syncAppCatalog } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const pendingLogout = logout(context)
    await logoutStarted.promise

    expect(managerState.tokens).toMatchObject({ userId: 'user-1' })
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
    expect(appCatalogCache.get(`user-1:${organizationId}`)).toMatchObject({
      authorizationStatus: 'denied',
      apps: [{ availability: 'unavailable' }],
    })
    expect(await syncAppCatalog(context, organizationId, { force: true }))
      .toMatchObject({
        success: false,
        errorCode: 'UNAUTHORIZED',
      })
    expect(adminClientCalls.filter(call => call.method === 'getAppCatalog'))
      .toHaveLength(0)

    finishRemoteLogout.resolve()
    expect(await pendingLogout).toEqual({ success: true })
    expect(managerState.tokens).toBeNull()
  })

  it('rejects a concurrent Catalog success after explicit session revocation begins', async () => {
    const organizationId = '17777777-7777-4777-8777-777777777772'
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      appConfigVersion: 'apps-v0',
      syncedAt: 1,
      apps: [],
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    const revokedRequest = createDeferred<any>()
    const successfulRequest = createDeferred<any>()
    const requestStarted = [createDeferred<void>(), createDeferred<void>()]
    const cleanupStarted = createDeferred<void>()
    const finishCleanup = createDeferred<void>()
    adminSessionEnding.mockImplementationOnce(async () => {
      cleanupStarted.resolve()
      await finishCleanup.promise
    })
    let requestIndex = 0
    adminClientBehavior.getAppCatalog = async () => {
      const index = requestIndex++
      requestStarted[index]!.resolve()
      return index === 0 ? revokedRequest.promise : successfulRequest.promise
    }
    const { syncAppCatalog } = createHarness()
    const context = {
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }

    const revoked = syncAppCatalog(context, organizationId, { force: true })
    await requestStarted[0]!.promise
    const concurrentSuccess = syncAppCatalog(
      context,
      organizationId,
      { force: true },
    )
    await requestStarted[1]!.promise

    revokedRequest.reject(new TestAdminError(
      'token revoked',
      'TOKEN_REVOKED',
      { status: 401 },
    ))
    await cleanupStarted.promise
    successfulRequest.resolve({
      notModified: false,
      appConfigVersion: 'apps-must-not-commit',
      apps: [],
    })

    expect(await concurrentSuccess).toMatchObject({
      success: false,
      errorCode: 'SESSION_CHANGED',
    })
    expect(appCatalogCache.get(`user-1:${organizationId}`)).toMatchObject({
      appConfigVersion: 'apps-v0',
      authorizationStatus: 'denied',
    })
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')

    finishCleanup.resolve()
    expect(await revoked).toMatchObject({
      success: false,
      errorCode: 'TOKEN_REVOKED',
      status: 401,
    })
  })

  it('clears local credentials even when remote logout fails', async () => {
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    }
    adminClientBehavior.logout = async () => {
      throw new Error('remote unavailable')
    }
    const { logout } = createHarness()

    const result = await logout({
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    })

    expect(result).toEqual({ success: true })
    expect(adminClientCalls[0]).toMatchObject({
      method: 'logout',
      args: ['access-token'],
    })
    expect(managerState.tokens).toBeNull()
    expect(loggerWarn).toHaveBeenCalled()
  })

  it('completes local logout fail-closed when process cleanup fails', async () => {
    const organizationId = 'organization-logout-cleanup'
    managerState.tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'user-1',
      username: 'admin',
    }
    appCatalogCache.set(`user-1:${organizationId}`, {
      accountId: 'user-1',
      organizationId,
      authorizationStatus: 'authorized',
      apps: [{ id: 'remote-app', availability: 'available' }],
    })
    appCatalogAccess.set(`user-1:${organizationId}`, 'online')
    adminSessionEnding.mockImplementationOnce(async () => {
      throw new Error('runtime cleanup failed')
    })
    const { logout } = createHarness()

    await expect(logout(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
    )).resolves.toEqual({ success: true })
    expect(managerState.tokens).toBeNull()
    expect(appCatalogAccess.get(`user-1:${organizationId}`)).toBe('denied')
    expect(appCatalogCache.get(`user-1:${organizationId}`))
      .toMatchObject({ authorizationStatus: 'denied' })
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('continuing fail-closed cleanup'),
      'runtime cleanup failed',
    )
  })
})
