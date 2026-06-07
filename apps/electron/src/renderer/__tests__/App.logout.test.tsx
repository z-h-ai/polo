import React from 'react'
import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NetworkError, TokenRevokedError } from '@polo-ai/shared/auth'
import {
  LoggedOutLoginPage,
  runRendererLogoutFlow,
} from '../lib/logout-flow'

function renderLoginRoute() {
  return renderToStaticMarkup(<LoggedOutLoginPage onSuccess={() => {}} />)
}

async function runLogoutCase(logout: () => Promise<void>) {
  const clearRendererState = mock(async () => {})
  let loginHtml = ''

  const result = await runRendererLogoutFlow({
    logout,
    clearRendererState,
    showLoginPage: () => {
      loginHtml = renderLoginRoute()
    },
  })

  expect(clearRendererState).toHaveBeenCalledTimes(1)
  expect(loginHtml).toContain('Sign in to continue')
  expect(loginHtml).toContain('name="username"')
  expect(loginHtml).toContain('name="password"')
  expect(loginHtml).toContain('type="submit"')

  return result
}

describe('App logout navigation', () => {
  it('renders LoginPage after a successful logout', async () => {
    const logout = mock(async () => {})

    const result = await runLogoutCase(logout)

    expect(logout).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ logoutSucceeded: true })
  })

  it('renders LoginPage after a network-failure logout', async () => {
    const apiError = new NetworkError('Admin unavailable')

    const result = await runLogoutCase(async () => {
      throw apiError
    })

    expect(result).toEqual({ logoutSucceeded: false, logoutError: apiError })
  })

  it('renders LoginPage after a 401 logout', async () => {
    const apiError = new TokenRevokedError(401, { error: 'token_revoked' })

    const result = await runLogoutCase(async () => {
      throw apiError
    })

    expect(result).toEqual({ logoutSucceeded: false, logoutError: apiError })
  })
})
