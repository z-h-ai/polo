/**
 * AsrAdapter registry (POL-20, card step 2): Map<supplier, adapter>. A request
 * for an unknown supplier surfaces an explicit error frame — never a silent
 * fallthrough (App 按 code 决定重试或禁按).
 */

import type { AsrAdapter } from './types.ts'

export class AsrAdapterRegistry {
  private readonly adapters = new Map<string, AsrAdapter>()

  register(adapter: AsrAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(id: string): AsrAdapter | undefined {
    return this.adapters.get(id)
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }

  ids(): string[] {
    return [...this.adapters.keys()]
  }
}
