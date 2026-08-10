import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const dockerfile = readFileSync('infra/updates-static/Dockerfile', 'utf8')

describe('updates-static release puller image', () => {
  it('makes the Service Exec entrypoint executable even when the remote builder drops source modes', () => {
    const copy = dockerfile.indexOf('COPY infra/updates-static/polo-release-pull /app/polo-release-pull')
    const chmod = dockerfile.indexOf('RUN chmod 0755 /app/polo-release-pull')

    expect(copy).toBeGreaterThan(0)
    expect(chmod).toBeGreaterThan(copy)
  })
})
