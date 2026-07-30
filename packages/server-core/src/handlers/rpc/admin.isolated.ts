import { beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { createCipheriv, hkdfSync } from 'node:crypto'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { AdminLlmConnection } from '@polo-ai/shared/admin'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

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
const adminSessionEnding = jest.fn(async (_accountId: string) => {})

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
}

mock.module('@polo-ai/shared/admin', () => ({
  AdminClient: MockAdminClient,
  AdminError: TestAdminError,
  setAppCatalogAccessMode: (
    accountId: string,
    organizationId: string,
    mode: string,
  ) => {
    appCatalogAccess.set(`${accountId}:${organizationId}`, mode)
  },
  getAppCatalogAccessMode: (accountId: string, organizationId: string) =>
    appCatalogAccess.get(`${accountId}:${organizationId}`) ?? 'offline',
  denyAppCatalogAccessForAccount: (accountId: string) => {
    for (const key of appCatalogAccess.keys()) {
      if (key.startsWith(`${accountId}:`)) appCatalogAccess.set(key, 'denied')
    }
  },
  getCachedAppCatalog: (accountId: string, organizationId: string) =>
    appCatalogCache.get(`${accountId}:${organizationId}`) ?? null,
  denyCachedAppCatalogAuthorization: (accountId: string, organizationId: string) => {
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
  getWorkspaceByNameOrId: () => null,
  setSetupDeferred: () => {},
}))

mock.module('@polo-ai/shared/credentials', () => ({
  getCredentialManager: () => mockCredentialManager,
}))

const { readApiKey, registerAdminHandlers } = await import('./admin')

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
  } satisfies HandlerDeps

  registerAdminHandlers(server, deps)

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
    syncConnections: requiredHandler(handlers, RPC_CHANNELS.admin.SYNC_CONNECTIONS),
    syncAppCatalog: requiredHandler(handlers, RPC_CHANNELS.admin.SYNC_APP_CATALOG),
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

beforeEach(() => {
  loggerWarn.mockClear()
  adminSessionEnding.mockClear()
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
})

describe('registerAdminHandlers', () => {
  it('registers every admin channel', () => {
    const harness = createHarness()

    expect(Object.keys(harness).sort()).toEqual([
      'acceptOrganizationJoin',
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
    expect(managerState.tokens).toMatchObject({ userId: 'user-1' })
    expect(appCatalogAccess.get('account-a:organization-1')).toBe('denied')
    expect(appCatalogCache.get('account-a:organization-1'))
      .toMatchObject({ authorizationStatus: 'denied' })
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
    expect(managerState.tokens).toMatchObject({
      userId: 'user-1',
      accessToken: 'access-token',
    })
  })

  it('fails closed without replacing credentials when old-account cleanup fails', async () => {
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

    expect(await login(
      { clientId: 'client-1', workspaceId: null, webContentsId: null },
      'admin',
      'secret',
    )).toMatchObject({ success: false })
    expect(adminSessionEnding).toHaveBeenCalledWith('account-a')
    expect(managerState.tokens).toMatchObject({
      userId: 'account-a',
      accessToken: 'account-a-token',
    })
    expect(adminClientCalls.map(call => call.method)).toEqual(['login'])
  })

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
    managerState.tokens = {
      accessToken: 'expired-access-token',
      refreshToken: 'revoked-refresh-token',
      expiresAt: Date.now() - 1000,
      userId: 'user-1',
      username: 'admin',
      displayName: 'Admin User',
    }
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
  })

  it('keeps the last app catalog when a non-auth refresh fails', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111'
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
      appConfigVersion: 'apps-v1',
      syncedAt: 50,
      apps: [],
    }
    appCatalogCache.set(`user-1:${organizationId}`, cached)
    adminClientBehavior.getAppCatalog = async () => {
      throw new TestAdminError('offline', 'NETWORK_ERROR')
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
      warningCode: 'NETWORK_ERROR',
      warning: 'Admin request failed',
    })
  })

  it('marks cached apps unavailable after an explicit catalog authorization failure', async () => {
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
      }],
    })
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
      success: true,
      source: 'cache',
      refreshed: false,
      catalog: {
        authorizationStatus: 'denied',
        apps: [{ id: 'app-1', availability: 'unavailable' }],
      },
    })
    expect(appCatalogCache.get(`user-1:${organizationId}`)).toMatchObject({
      authorizationStatus: 'denied',
      apps: [{ availability: 'unavailable' }],
    })
    expect(managerState.tokens).toBeNull()
    expect(adminSessionEnding).toHaveBeenCalledWith('user-1')
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
})
