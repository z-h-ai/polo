import { zipSync } from 'fflate'
import { readFile, readdir, writeFile } from 'node:fs/promises'
const files = {}
async function collect(path = '') { for (const entry of await readdir(`dist/${path}`, { withFileTypes: true })) { const key = path + entry.name; if (entry.isDirectory()) await collect(key + '/'); else files[key] = new Uint8Array(await readFile(`dist/${key}`)) } }
await collect(); if (!files['polo-app.json'] || !files['web/index.html']) throw new Error('Run build first')
await writeFile('polo-payload.zip', zipSync(files, { level: 6 }))
console.log('Created rootless polo-payload.zip (no local-import entitlement implied)')
