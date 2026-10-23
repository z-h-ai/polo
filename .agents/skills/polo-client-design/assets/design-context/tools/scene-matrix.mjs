import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const catalog = JSON.parse(readFileSync(resolve(root, 'scene-catalog.json'), 'utf8'))
const rows = catalog.scenes.flatMap((scene) => scene.states.map((state) => ({ scene: scene.id, state, group: scene.group, label: scene.label, source: scene.source })))
const output = resolve(root, 'screenshots/scene-matrix.json')
writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2) + '\n')
console.log('Wrote ' + output + ' with ' + rows.length + ' scene/state combinations')
