export const MIN_CHAT_WIDTH = 360

/** Collapse navigation before a side resource squeezes the editable chat below 360px.
 * Use expanded navigation widths so the decision remains stable after collapsing. */
export function shouldAutoHideNavigation(shellWidth: number, navigationWidth: number, rightPaneRatio: number): boolean {
  return shellWidth > 0 && (shellWidth < 768 || shellWidth * (1 - rightPaneRatio) - navigationWidth < MIN_CHAT_WIDTH)
}
