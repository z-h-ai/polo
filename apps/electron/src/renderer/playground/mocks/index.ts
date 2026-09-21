/**
 * Playground mock infrastructure (POO-70 HiFi, WS-F).
 *
 * Self-contained providers/containers that let product components render in
 * demos without the real electronAPI or app-level providers.
 */
export { MockTabShellProvider } from './MockTabShell'
export type { MockTabShellProviderProps } from './MockTabShell'

export { MockOrganizationProvider, makeOrganizationSummary } from './MockOrganization'
export type {
  MockOrganizationProviderProps,
  MakeOrganizationSummaryOverrides,
} from './MockOrganization'

export { DemoFixedContainer } from './DemoFixedContainer'
export type { DemoFixedContainerProps } from './DemoFixedContainer'

export { extendMockElectronAPI } from './electronApi'
