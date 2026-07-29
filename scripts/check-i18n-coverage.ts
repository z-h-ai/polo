/**
 * CI-safe i18n callsite coverage check.
 *
 * Verifies literal t('...'), i18n.t('...'), and <Trans i18nKey="...">
 * references in application/package source resolve against the English locale.
 * Dynamic keys are intentionally skipped and remain covered by i18next runtime
 * missing-key warnings.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx'])
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.pipeline',
  '.turbo',
  'build',
  'coverage',
  'design-demos',
  'dist',
  'node_modules',
  'out',
])

export interface TranslationReference {
  file: string
  key: string
  line: number
}

function lineAt(source: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1
  }
  return line
}

export function collectLiteralTranslationReferences(
  source: string,
  file: string,
): TranslationReference[] {
  const references: TranslationReference[] = []
  const patterns = [
    /(?:\bi18n\s*\.\s*|\b)t\s*\(\s*(['"])([^'"\\\r\n]+)\1/g,
    /<Trans\b[^>]*\bi18nKey\s*=\s*(['"])([^'"\\\r\n]+)\1/g,
    /<Trans\b[^>]*\bi18nKey\s*=\s*\{\s*(['"])([^'"\\\r\n]+)\1\s*\}/g,
  ]

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      references.push({
        file,
        key: match[2],
        line: lineAt(source, match.index ?? 0),
      })
    }
  }

  return references
}

export function translationKeyExists(
  key: string,
  englishMessages: Record<string, string>,
): boolean {
  return Object.hasOwn(englishMessages, key)
    || (
      Object.hasOwn(englishMessages, `${key}_one`)
      && Object.hasOwn(englishMessages, `${key}_other`)
    )
}

function collectSourceFiles(directory: string, output: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        collectSourceFiles(join(directory, entry.name), output)
      }
      continue
    }

    const file = join(directory, entry.name)
    if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      output.push(file)
    }
  }
}

export function findMissingTranslationReferences(rootDirectory: string): TranslationReference[] {
  const englishLocalePath = join(
    rootDirectory,
    'packages/shared/src/i18n/locales/en.json',
  )
  const englishMessages = JSON.parse(
    readFileSync(englishLocalePath, 'utf8'),
  ) as Record<string, string>
  const sourceFiles: string[] = []

  for (const sourceRoot of ['apps', 'packages']) {
    collectSourceFiles(join(rootDirectory, sourceRoot), sourceFiles)
  }

  return sourceFiles.flatMap(file => {
    const references = collectLiteralTranslationReferences(
      readFileSync(file, 'utf8'),
      relative(rootDirectory, file),
    )
    return references.filter(reference =>
      !translationKeyExists(reference.key, englishMessages))
  })
}

function main(): void {
  const rootDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const missing = findMissingTranslationReferences(rootDirectory)

  if (missing.length > 0) {
    console.error(`i18n coverage failed: ${missing.length} literal key reference(s) are missing from en.json`)
    for (const reference of missing) {
      console.error(`  ${reference.file}:${reference.line}  ${reference.key}`)
    }
    process.exitCode = 1
    return
  }

  console.log('i18n coverage passed: every literal translation key resolves in en.json')
}

if (import.meta.main) {
  main()
}
