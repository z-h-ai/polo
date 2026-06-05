export function isPlatformMode(): boolean {
  return !!process.env.PLATFORM_ANTHROPIC_API_KEY;
}
