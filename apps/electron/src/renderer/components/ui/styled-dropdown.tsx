/**
 * Styled Dropdown Components
 *
 * Re-exports from @polo-ai/ui for shared styling across packages. Imported
 * via the `@polo-ai/ui/ui/styled-dropdown` subpath (not the package barrel):
 * the barrel eagerly pulls in the react-pdf overlay whose
 * `pdfjs-dist/build/pdf.worker.min.mjs?url` import only resolves under Vite —
 * pulling it into bun-test module graphs that don't mock it (e.g. the
 * TabShell scope-isolation reduced tree, which renders the workbench bar)
 * breaks them at load time.
 */

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuShortcut,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '@polo-ai/ui/ui/styled-dropdown'
