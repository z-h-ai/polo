import { afterEach, afterAll, describe, expect, it } from 'bun:test'
import {
  OpenVikingError,
  openVikingAddResource,
  openVikingDelete,
  openVikingFind,
  openVikingTempUpload,
  readOpenVikingConfig,
  resetOpenVikingTimeoutsForTests,
  setOpenVikingTimeoutsForTests,
  type OpenVikingConfig,
} from '../openviking-client'

/**
 * Wire-shape tests for the minimal OpenViking client (POO-108 v2): the
 * request/response shapes are the ones verified against a real local
 * OpenViking instance, so the stub asserts them literally — method, path,
 * body fields, multipart field name and the `{"status":"ok","result":…}`
 * envelope — plus the bounded-timeout degradation.
 */

interface RecordedRequest {
  method: string
  path: string
  search: URLSearchParams
  body: string
  contentType: string | null
  authorization: string | null
  /** The `file` multipart entry, when the request carried one. */
  file: { name: string; content: string } | null
}

const requests: RecordedRequest[] = []

let respond: (url: URL, method: string) => Response | Promise<Response> = () =>
  Response.json({ status: 'ok', result: {} })

const server = Bun.serve({
  port: 0,
  fetch: async request => {
    const url = new URL(request.url)
    const contentType = request.headers.get('content-type')
    let file: { name: string; content: string } | null = null
    let body = ''
    if (contentType?.startsWith('multipart/form-data')) {
      const entry = (await request.formData()).get('file')
      // The Bun/undici `File` type vs the lib `FormData` entry value disagree,
      // so the file name is read through the runtime shape it actually has.
      const uploaded = entry as File | null
      file = uploaded instanceof Blob ? { name: uploaded.name, content: await uploaded.text() } : null
      body = file ? `file:${file.name}:${file.content}` : '<no file field>'
    } else {
      body = await request.text()
    }
    requests.push({
      method: request.method,
      path: url.pathname,
      search: url.searchParams,
      body,
      contentType,
      authorization: request.headers.get('authorization'),
      file,
    })
    return respond(url, request.method)
  },
})

const config: OpenVikingConfig = { baseUrl: `http://127.0.0.1:${server.port}` }

afterEach(() => {
  requests.length = 0
  respond = () => Response.json({ status: 'ok', result: {} })
  resetOpenVikingTimeoutsForTests()
})

afterAll(() => {
  server.stop(true)
})

describe('openviking client configuration', () => {
  it('is configured only when the URL env is set, and normalizes it', () => {
    expect(readOpenVikingConfig({})).toBeNull()
    expect(readOpenVikingConfig({ POLO_OPENVIKING_URL: '   ' })).toBeNull()
    expect(readOpenVikingConfig({ POLO_OPENVIKING_URL: 'http://127.0.0.1:1933///' }))
      .toEqual({ baseUrl: 'http://127.0.0.1:1933' })
    expect(readOpenVikingConfig({ POLO_OPENVIKING_URL: 'http://ov:1933', POLO_OPENVIKING_API_KEY: ' k ' }))
      .toEqual({ baseUrl: 'http://ov:1933', apiKey: 'k' })
  })
})

describe('openviking client wire shapes', () => {
  it('uploads content as the multipart `file` field and reads back the temp id', async () => {
    respond = () => Response.json({ status: 'ok', result: { temp_file_id: 'upload_x.md' } })
    const result = await openVikingTempUpload(config, { filename: 'kb-1.md', content: '# Hello' })
    expect(result).toEqual({ tempFileId: 'upload_x.md' })
    const request = requests[0]
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/api/v1/resources/temp_upload')
    expect(request.contentType?.startsWith('multipart/form-data')).toBe(true)
    expect(request.file).toEqual({ name: 'kb-1.md', content: '# Hello' })
    expect(request.body).toBe('file:kb-1.md:# Hello')
  })

  it('refuses a temp_upload result without a temp_file_id', async () => {
    respond = () => Response.json({ status: 'ok', result: {} })
    await expect(openVikingTempUpload(config, { filename: 'kb-1.md', content: 'x' }))
      .rejects.toMatchObject({ code: 'openviking_invalid_response', name: 'OpenVikingError' })
  })

  it('adds a resource with the verified body shape and optional bearer auth', async () => {
    respond = () => Response.json({ status: 'ok', result: { root_uri: 'viking://resources/entspace-x', status: 'success' } })
    const result = await openVikingAddResource(
      { baseUrl: config.baseUrl, apiKey: 'secret' },
      {
        tempFileId: 'upload_x.md',
        to: 'viking://resources/entspace-x/.space.md',
        createParent: true,
        wait: true,
        processingMode: 'vectors_only',
        tags: ['polo_space=ps-one', 'kind=polo_space_manifest'],
        reason: 'provision',
      },
    )
    expect(result).toEqual({ rootUri: 'viking://resources/entspace-x', status: 'success' })
    const request = requests[0]
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/api/v1/resources')
    expect(request.contentType).toBe('application/json')
    expect(request.authorization).toBe('Bearer secret')
    expect(JSON.parse(request.body)).toEqual({
      temp_file_id: 'upload_x.md',
      to: 'viking://resources/entspace-x/.space.md',
      create_parent: true,
      wait: true,
      processing_mode: 'vectors_only',
      // Tags stay `k=v` STRINGS — the real instance rejects objects.
      tags: ['polo_space=ps-one', 'kind=polo_space_manifest'],
      reason: 'provision',
    })
  })

  it('finds resources inside a target uri, tolerating both tag shapes', async () => {
    respond = () => Response.json({
      status: 'ok',
      result: {
        resources: [
          { uri: 'viking://resources/entspace-x/a.md', score: 0.818, tags: ['doc=kb-1', 'polo_space=ps-one'], abstract: '' },
          { uri: 'viking://resources/entspace-x/b.md', score: '0.5', tags: { doc: 'kb-2' }, abstract: null },
          // Malformed rows are skipped, never fatal.
          { score: 1 },
          { uri: 'viking://resources/entspace-x/c.md', score: 'not-a-number' },
        ],
      },
    })
    const resources = await openVikingFind(config, {
      query: '入职一年有几天年假',
      targetUri: 'viking://resources/entspace-x',
      limit: 20,
    })
    expect(resources).toHaveLength(2)
    expect(resources[0]).toEqual({
      uri: 'viking://resources/entspace-x/a.md',
      score: 0.818,
      tags: { doc: 'kb-1', polo_space: 'ps-one' },
      abstract: '',
    })
    expect(resources[1].tags).toEqual({ doc: 'kb-2' })
    expect(resources[1].score).toBe(0.5)
    expect(resources[1].abstract).toBeNull()
    expect(JSON.parse(requests[0].body)).toEqual({
      query: '入职一年有几天年假',
      target_uri: 'viking://resources/entspace-x',
      context_type: ['resource'],
      limit: 20,
    })
  })

  it('deletes through /api/v1/fs with the uri and recursive query params', async () => {
    await openVikingDelete(config, { uri: 'viking://resources/entspace-x/collections/c/kb-1.md', recursive: false })
    const request = requests[0]
    expect(request.method).toBe('DELETE')
    expect(request.path).toBe('/api/v1/fs')
    expect(request.search.get('uri')).toBe('viking://resources/entspace-x/collections/c/kb-1.md')
    expect(request.search.get('recursive')).toBe('false')
  })
})

describe('openviking client failures', () => {
  it('maps an HTTP error status to a structured error carrying the status', async () => {
    respond = () => Response.json({ status: 'error', error: 'boom' }, { status: 500 })
    const error = await openVikingAddResource(config, { tempFileId: 't', to: 'viking://x' }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(OpenVikingError)
    expect(error).toMatchObject({ code: 'openviking_http_error', status: 500 })
    expect((error as Error).message).toContain('HTTP 500')
    expect((error as Error).message).toContain('boom')
  })

  it('maps a non-ok envelope to an invalid-response error', async () => {
    respond = () => Response.json({ status: 'error', error: 'quota exceeded' })
    await expect(openVikingFind(config, { query: 'q', targetUri: 'viking://x', limit: 5 }))
      .rejects.toMatchObject({ code: 'openviking_invalid_response' })
  })

  it('maps a non-JSON body to an invalid-response error', async () => {
    respond = () => new Response('<html>gateway</html>', { status: 200 })
    await expect(openVikingTempUpload(config, { filename: 'a.md', content: 'x' }))
      .rejects.toMatchObject({ code: 'openviking_invalid_response' })
  })

  it('maps a refused connection to a network error', async () => {
    // Port 1 on localhost: nothing listens, the TCP connect fails immediately.
    await expect(openVikingFind({ baseUrl: 'http://127.0.0.1:1' }, { query: 'q', targetUri: 'viking://x', limit: 5 }))
      .rejects.toMatchObject({ code: 'openviking_network_error' })
  })

  it('maps a stalled response to the bounded-timeout error', async () => {
    setOpenVikingTimeoutsForTests({ searchMs: 50 })
    respond = () => new Promise(() => {}) // never settles
    const pending = openVikingFind(config, { query: 'q', targetUri: 'viking://x', limit: 5 })
    await expect(pending).rejects.toMatchObject({ code: 'openviking_timeout' })
  })
})
