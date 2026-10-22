import { SettingsManager, createExtensionRuntime, type ResourceLoader } from '@mariozechner/pi-coding-agent';
import { MANAGED_TOOL_UNSUPPORTED } from '../../shared/src/agent/tool-execution-policy.ts';

/** Never instantiate DefaultResourceLoader: even noExtensions resolves packages.
 * The host supplies its normal system prompt; cwd text cannot install resources. */
export function managedResources() {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [MANAGED_TOOL_UNSUPPORTED],
    extendResources: () => { throw new Error(MANAGED_TOOL_UNSUPPORTED); },
    reload: async () => {},
  };
  return { settingsManager: SettingsManager.inMemory(), resourceLoader };
}
