import { useMemo, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTabShell } from '@/context/TabShellContext'
import {
  createTabId,
  isValidWebAppUrl,
  normalizeWebAppUrl,
  type AppDefinition,
} from '../../../shared/tab-browser-types'

const MAX_ICON_BYTES = 256 * 1024

interface AddAppDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function AddAppDialog({ open, onOpenChange }: AddAppDialogProps) {
  const { installedApps, addApp, openApp } = useTabShell()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [iconUrl, setIconUrl] = useState<string | undefined>()
  const normalizedUrl = useMemo(() => normalizeWebAppUrl(url), [url])
  const duplicate = installedApps.some((app) => app.type === 'webapp' && app.url === normalizedUrl)
  const isValid = name.trim().length > 0 && name.trim().length <= 30 && isValidWebAppUrl(normalizedUrl)

  const reset = () => {
    setName('')
    setUrl('')
    setIconUrl(undefined)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!isValid) {
      toast.error('Enter a name and a valid HTTPS or local HTTP URL.')
      return
    }

    const now = Date.now()
    const app: AppDefinition = {
      id: createTabId('app'),
      name: name.trim(),
      url: normalizedUrl,
      iconUrl,
      type: 'webapp',
      createdAt: now,
      order: Math.max(0, ...installedApps.map((item) => item.order)) + 1,
    }

    await addApp(app)
    openApp(app)
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      onOpenChange(nextOpen)
      if (!nextOpen) reset()
    }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Add external app</DialogTitle>
          <DialogDescription>
            Add a personal website shortcut to your Polo launcher.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="tab-app-name">Name</label>
            <input
              id="tab-app-name"
              className="h-9 w-full rounded-md border border-foreground/15 bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={name}
              maxLength={30}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="tab-app-url">URL</label>
            <input
              id="tab-app-url"
              className="h-9 w-full rounded-md border border-foreground/15 bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={url}
              placeholder="https://intranet.example.com"
              onChange={(event) => setUrl(event.target.value)}
            />
            {url && !isValidWebAppUrl(normalizedUrl) && (
              <p className="text-xs text-destructive">Use HTTPS, or HTTP only for localhost/private network hosts.</p>
            )}
            {duplicate && (
              <p className="text-xs text-amber-600">This URL is already installed. You can still add another shortcut.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="tab-app-icon">Icon</label>
            <input
              id="tab-app-icon"
              type="file"
              accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
              className="block w-full text-sm text-foreground/70 file:mr-3 file:h-8 file:rounded-md file:border-0 file:bg-foreground/8 file:px-3 file:text-sm file:text-foreground hover:file:bg-foreground/12"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (!file) return
                if (file.size > MAX_ICON_BYTES) {
                  event.target.value = ''
                  toast.error('Icon file must be under 256 KB.')
                  return
                }
                void readFileAsDataUrl(file).then(setIconUrl).catch(() => {
                  toast.error('Could not read icon file.')
                })
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!isValid}>Add external app</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
