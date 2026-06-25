export type CliDomainNamespace = 'label' | 'source' | 'skill' | 'automation' | 'permission' | 'theme'

export interface CliDomainPolicy {
  namespace: CliDomainNamespace
  helpCommand: string
  workspacePathScopes: string[]
  readActions: string[]
  quickExamples: string[]
  /** Optional workspace-relative paths guarded for direct Bash operations */
  bashGuardPaths?: string[]
}

const POLICIES: Record<CliDomainNamespace, CliDomainPolicy> = {
  label: {
    namespace: 'label',
    helpCommand: 'polo-ai label --help',
    workspacePathScopes: ['labels/**'],
    readActions: ['list', 'get', 'auto-rule-list', 'auto-rule-validate'],
    quickExamples: [
      'polo-ai label list',
      'polo-ai label create --name "Bug" --color "accent"',
      'polo-ai label update bug --json \'{"name":"Bug Report"}\'',
    ],
    bashGuardPaths: ['labels/**'],
  },
  source: {
    namespace: 'source',
    helpCommand: 'polo-ai source --help',
    workspacePathScopes: ['sources/**'],
    readActions: ['list', 'get', 'validate', 'test', 'auth-help'],
    quickExamples: [
      'polo-ai source list',
      'polo-ai source get <slug>',
      'polo-ai source update <slug> --json "{...}"',
      'polo-ai source validate <slug>',
    ],
  },
  skill: {
    namespace: 'skill',
    helpCommand: 'polo-ai skill --help',
    workspacePathScopes: ['skills/**'],
    readActions: ['list', 'get', 'validate', 'where'],
    quickExamples: [
      'polo-ai skill list',
      'polo-ai skill get <slug>',
      'polo-ai skill update <slug> --json "{...}"',
      'polo-ai skill validate <slug>',
    ],
  },
  automation: {
    namespace: 'automation',
    helpCommand: 'polo-ai automation --help',
    workspacePathScopes: ['automations.json', 'automations-history.jsonl'],
    readActions: ['list', 'get', 'validate', 'history', 'last-executed', 'test', 'lint'],
    quickExamples: [
      'polo-ai automation list',
      'polo-ai automation create --event UserPromptSubmit --prompt "Summarize this prompt"',
      'polo-ai automation update <id> --json "{\"enabled\":false}"',
      'polo-ai automation history <id> --limit 20',
      'polo-ai automation validate',
    ],
    bashGuardPaths: ['automations.json', 'automations-history.jsonl'],
  },
  permission: {
    namespace: 'permission',
    helpCommand: 'polo-ai permission --help',
    workspacePathScopes: ['permissions.json', 'sources/*/permissions.json'],
    readActions: ['list', 'get', 'validate'],
    quickExamples: [
      'polo-ai permission list',
      'polo-ai permission get --source linear',
      'polo-ai permission add-mcp-pattern "list" --comment "All list ops" --source linear',
      'polo-ai permission validate',
    ],
    bashGuardPaths: ['permissions.json', 'sources/*/permissions.json'],
  },
  theme: {
    namespace: 'theme',
    helpCommand: 'polo-ai theme --help',
    workspacePathScopes: ['config.json', 'theme.json', 'themes/*.json'],
    readActions: ['get', 'validate', 'list-presets', 'get-preset'],
    quickExamples: [
      'polo-ai theme get',
      'polo-ai theme list-presets',
      'polo-ai theme set-color-theme nord',
      'polo-ai theme set-workspace-color-theme default',
      'polo-ai theme set-override --json "{\"accent\":\"#3b82f6\"}"',
    ],
    bashGuardPaths: ['config.json', 'theme.json', 'themes/*.json'],
  },
}

export const CLI_DOMAIN_POLICIES = POLICIES

export interface CliDomainScopeEntry {
  namespace: CliDomainNamespace
  scope: string
}

function dedupeScopes(scopes: string[]): string[] {
  return [...new Set(scopes)]
}

/**
 * Canonical workspace-relative path scopes owned by polo-ai CLI domains.
 * Use these for file-path ownership checks to avoid drift across call sites.
 */
export const POLO_AI_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.workspacePathScopes)
)

/**
 * Canonical workspace-relative path scopes guarded for direct Bash operations.
 */
export const POLO_AI_AGENTS_CLI_OWNED_BASH_GUARD_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.bashGuardPaths ?? [])
)

/**
 * Namespace-aware workspace scope entries for polo-ai CLI owned paths.
 */
export const POLO_AI_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => policy.workspacePathScopes.map(scope => ({ namespace: policy.namespace, scope })))

/**
 * Namespace-aware Bash guard scope entries.
 */
export const POLO_AI_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => (policy.bashGuardPaths ?? []).map(scope => ({ namespace: policy.namespace, scope })))

export interface BashPatternRule {
  pattern: string
  comment: string
}

/**
 * Derive the canonical Explore-mode read-only polo-ai bash patterns from
 * CLI domain policies. Keeps permissions regexes aligned with command metadata.
 */
export function getPoloAiReadOnlyBashPatterns(): BashPatternRule[] {
  const namespaces = Object.keys(POLICIES) as CliDomainNamespace[]
  const namespaceAlternation = namespaces.join('|')

  const rules: BashPatternRule[] = namespaces.map((namespace) => {
    const policy = POLICIES[namespace]
    const actions = policy.readActions.join('|')
    return {
      pattern: `^polo-ai\\s+${namespace}\\s+(${actions})\\b`,
      comment: `polo-ai ${namespace} read-only operations`,
    }
  })

  rules.push(
    { pattern: '^polo-ai\\s*$', comment: 'polo-ai bare invocation (prints help)' },
    { pattern: `^polo-ai\\s+(${namespaceAlternation})\\s*$`, comment: 'polo-ai entity help' },
    { pattern: `^polo-ai\\s+(${namespaceAlternation})\\s+--help\\b`, comment: 'polo-ai entity help flags' },
    { pattern: '^polo-ai\\s+--(help|version|discover)\\b', comment: 'polo-ai global flags' },
  )

  return rules
}

export function getCliDomainPolicy(namespace: CliDomainNamespace): CliDomainPolicy {
  return POLICIES[namespace]
}
