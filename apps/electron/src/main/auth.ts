import { app, ipcMain, safeStorage } from 'electron'
import { mkdir, rename, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  AccountDisabledError,
  AdminAuthApiError,
  ConfigError,
  InvalidCredentialsError,
  NetworkError,
  RateLimitedError,
  createAdminApiClient,
  type AdminApiClient,
  type AdminUser,
} from '@polo-ai/shared/auth'

const AUTH_LOGIN_CHANNEL = 'auth:login'
const SESSION_FILE_NAME = 'admin-session.json'

type IpcMainLike = Pick<typeof ipcMain, 'handle'>
type AppLike = Pick<typeof app, 'getPath'>
type SafeStorageLike = Pick<typeof safeStorage, 'encryptString'> & {
  isEncryptionAvailable?: () => boolean
}

export interface ElectronAdminTokenStore {
  save(token: string, user: AdminUser): Promise<void>
}

export interface RegisterElectronAuthHandlersOptions {
  ipcMain?: IpcMainLike
  app?: AppLike
  safeStorage?: SafeStorageLike
  adminApiClient?: Pick<AdminApiClient, 'login'>
  tokenStore?: ElectronAdminTokenStore
}

interface IpcLoginErrorShape {
  code: string
  message: string
  statusCode?: number
  retryAfterSeconds?: number
}

type AuthLoginIpcResponse = { user: AdminUser } | { error: IpcLoginErrorShape }

export class SafeStorageAdminTokenStore implements ElectronAdminTokenStore {
  private readonly appApi: AppLike
  private readonly safeStorageApi: SafeStorageLike

  constructor(options: Pick<RegisterElectronAuthHandlersOptions, 'app' | 'safeStorage'> = {}) {
    this.appApi = options.app ?? app
    this.safeStorageApi = options.safeStorage ?? safeStorage
  }

  async save(token: string, user: AdminUser): Promise<void> {
    if (this.safeStorageApi.isEncryptionAvailable && !this.safeStorageApi.isEncryptionAvailable()) {
      throw createIpcLoginError({
        code: 'storage_error',
        message: 'Secure Admin token storage is unavailable',
      })
    }

    const encryptedToken = this.safeStorageApi.encryptString(token).toString('base64')
    const filePath = join(this.appApi.getPath('userData'), 'auth', SESSION_FILE_NAME)
    const tempPath = `${filePath}.tmp`
    const payload = {
      version: 1,
      userId: user.id,
      username: user.username,
      role: user.role,
      encryptedToken,
      updatedAt: new Date().toISOString(),
    }

    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(tempPath, JSON.stringify(payload, null, 2), { mode: 0o600 })
    await rename(tempPath, filePath)
    await chmod(filePath, 0o600).catch(() => {
      // chmod can be unsupported on some filesystems; encrypted safeStorage data
      // is still the security boundary.
    })
  }
}

export function registerElectronAuthHandlers(options: RegisterElectronAuthHandlersOptions = {}) {
  const ipc = options.ipcMain ?? ipcMain
  const tokenStore = options.tokenStore ?? new SafeStorageAdminTokenStore(options)

  ipc.handle(AUTH_LOGIN_CHANNEL, async (_event, username: unknown, password: unknown): Promise<AuthLoginIpcResponse> => {
    if (typeof username !== 'string' || typeof password !== 'string') {
      return {
        error: {
          code: 'validation_error',
          message: 'username and password are required',
          statusCode: 400,
        },
      }
    }

    try {
      const adminClient = options.adminApiClient ?? createAdminApiClient()
      const result = await adminClient.login(username, password)
      await tokenStore.save(result.token, result.user)
      return { user: result.user }
    } catch (error) {
      return { error: serializeIpcLoginError(mapAdminLoginError(error)) }
    }
  })
}

export function mapAdminLoginError(error: unknown): Error {
  if (isIpcLoginError(error)) {
    return error
  }

  if (error instanceof InvalidCredentialsError) {
    return createIpcLoginError({
      code: 'invalid_credentials',
      message: error.message,
      statusCode: error.statusCode,
    })
  }

  if (error instanceof AccountDisabledError) {
    return createIpcLoginError({
      code: 'account_disabled',
      message: error.message,
      statusCode: error.statusCode,
    })
  }

  if (error instanceof RateLimitedError) {
    return createIpcLoginError({
      code: 'rate_limited',
      message: error.message,
      statusCode: error.statusCode,
      retryAfterSeconds: error.retryAfterSeconds,
    })
  }

  if (error instanceof NetworkError) {
    return createIpcLoginError({
      code: 'network_error',
      message: error.message,
    })
  }

  if (error instanceof ConfigError) {
    return createIpcLoginError({
      code: 'config_error',
      message: error.message,
    })
  }

  if (error instanceof AdminAuthApiError) {
    return createIpcLoginError({
      code: error.error || 'login_failed',
      message: error.message,
      statusCode: error.statusCode,
    })
  }

  const message = error instanceof Error ? error.message : 'Login failed'
  return createIpcLoginError({ code: 'unknown', message })
}

function createIpcLoginError(shape: IpcLoginErrorShape): Error {
  return Object.assign(new Error(shape.message), shape)
}

function serializeIpcLoginError(error: Error): IpcLoginErrorShape {
  const shaped = error as Error & Partial<IpcLoginErrorShape>
  return {
    code: shaped.code ?? 'unknown',
    message: shaped.message,
    statusCode: shaped.statusCode,
    retryAfterSeconds: shaped.retryAfterSeconds,
  }
}

function isIpcLoginError(error: unknown): error is Error & IpcLoginErrorShape {
  return error instanceof Error
    && typeof (error as Partial<IpcLoginErrorShape>).code === 'string'
}
