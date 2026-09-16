export type RecentDirScenario = 'none' | 'few' | 'many'

const RECENT_DIR_SCENARIO_DATA: Record<RecentDirScenario, string[]> = {
  none: [],
  few: [
    '/Users/demo/projects/polo-ai',
    '/Users/demo/projects/polo-ai/apps/electron',
    '/Users/demo/projects/polo-ai/packages/shared',
  ],
  many: [
    '/Users/demo/projects/polo-ai',
    '/Users/demo/projects/polo-ai/apps/electron',
    '/Users/demo/projects/polo-ai/apps/viewer',
    '/Users/demo/projects/polo-ai/apps/cli',
    '/Users/demo/projects/polo-ai/packages/shared',
    '/Users/demo/projects/polo-ai/packages/server-core',
    '/Users/demo/projects/polo-ai/packages/pi-agent-server',
    '/Users/demo/projects/polo-ai/packages/ui',
    '/Users/demo/projects/polo-ai/scripts',
  ],
}

/** Return a copy of the fixture list for the selected scenario. */
export function getRecentDirsForScenario(scenario: RecentDirScenario): string[] {
  return [...RECENT_DIR_SCENARIO_DATA[scenario]]
}
