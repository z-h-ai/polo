import { zipSync } from 'fflate'
import { readFile, readdir, writeFile } from 'node:fs/promises'
const files = {}
async function collect(path = '') { for (const entry of await readdir(`dist/${path}`, { withFileTypes: true })) { const key = path + entry.name; if (entry.isDirectory()) await collect(key + '/'); else files[key] = new Uint8Array(await readFile(`dist/${key}`)) } }
await collect()
if (['polo-app.json', 'index.html', 'app.js', 'app.css'].some(name => !files[name]?.byteLength)) throw new Error('Run build first; the manifest and static assets must be nonempty')
const manifest = JSON.parse(new TextDecoder().decode(files['polo-app.json']))
if (manifest.runtime !== 'static' || !Array.isArray(manifest.entry) || manifest.entry.length !== 1 || manifest.entry[0] !== 'index.html') throw new Error('Expected exactly one static index.html entry; run build first')
await writeFile('polo-payload.zip', zipSync(files, { level: 6 }))
console.log('Created rootless Creator payload polo-payload.zip (platform manifest and authorization required)')
