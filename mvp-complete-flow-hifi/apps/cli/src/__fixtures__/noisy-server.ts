const secret = 'server-spawner-secret-value-123456'

for (let index = 0; index < 256; index++) {
  process.stderr.write('x'.repeat(1024))
}
process.stderr.write(secret.slice(0, 17))
await Bun.sleep(5)
process.stderr.write(`${secret.slice(17)}\n`)
process.stderr.write(`credential=${process.env.POLO_FAKE_API_KEY ?? 'missing'}\n`)
process.stderr.write(`custom-oauth=${process.env.COMPANY_SSO_REFRESH_MATERIAL ?? 'missing'}\n`)
process.stderr.write(`config-dir=${process.env.POLO_AI_CONFIG_DIR ?? 'missing'}\n`)
process.stdout.write('POLO_AI_SERVER_URL=ws://127.0.0.1:1\n')

process.on('SIGTERM', () => process.exit(0))
await new Promise(() => {})
