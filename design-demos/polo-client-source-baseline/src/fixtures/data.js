export const sessions = [
  { id: 'welcome', title: 'Welcome to Polo', detail: 'Getting started with your workspace', time: 'Just now', active: true },
  { id: 'prototype', title: 'Prototype planning', detail: 'Reusable mock prototype architecture', time: '12 min ago' },
  { id: 'release', title: 'Release checklist', detail: 'Review the latest workspace changes', time: 'Yesterday' },
  { id: 'research', title: 'Research notes', detail: 'Collected source and design references', time: 'Mon' },
]

export const products = [
  { id: 'assistant', name: 'Polo Assistant', description: 'Ask questions, draft plans, and run workspace actions.', art: '✦', tone: 'violet', status: 'Ready' },
  { id: 'browser', name: 'Browser', description: 'Open web apps and keep browser tasks in one place.', art: '◌', tone: 'teal', status: 'Ready' },
  { id: 'skills', name: 'Skill Library', description: 'Discover and manage reusable skills for your team.', art: '⌘', tone: 'amber', status: '3 updates' },
]

export const sources = [
  { id: 'github', name: 'GitHub', type: 'API source', detail: 'Repository access and pull requests', status: 'Connected', tone: 'good' },
  { id: 'notion', name: 'Notion', type: 'MCP source', detail: 'Workspace pages and databases', status: 'Connected', tone: 'good' },
  { id: 'local', name: 'Local files', type: 'Local source', detail: 'Files from the current workspace', status: 'Needs permission', tone: 'info' },
]

export const skills = [
  { id: 'frontend-prototype', name: 'Frontend Prototype', description: 'Turn source UI into an interactive, source-faithful prototype.', badge: 'Project', status: 'Installed' },
  { id: 'browser-research', name: 'Browser Research', description: 'Collect and summarize information from permitted websites.', badge: 'Safety reviewed', status: 'Update available' },
  { id: 'release-notes', name: 'Release Notes', description: 'Draft concise release notes from workspace activity.', badge: 'Creator skill', status: 'Installed' },
]

export const automations = [
  { id: 'daily-digest', name: 'Daily workspace digest', kind: 'Scheduled', rule: 'Every weekday at 09:00', status: 'Active' },
  { id: 'pr-review', name: 'Review new pull requests', kind: 'Event-based', rule: 'When a pull request is opened', status: 'Active' },
  { id: 'stale-session', name: 'Flag stale sessions', kind: 'Agentic', rule: 'When a session is inactive for 7 days', status: 'Paused' },
]

export const settingsGroups = [
  { id: 'app', label: 'App', items: [{ id: 'appearance', label: 'Appearance', description: 'Theme, language, font' }, { id: 'input', label: 'Input & sending', description: 'Typing and message behavior' }, { id: 'notifications', label: 'Notifications', description: 'Desktop and sound alerts' }] },
  { id: 'workspace', label: 'Workspace', items: [{ id: 'workspace', label: 'Workspace', description: 'Name, path, and defaults' }, { id: 'permissions', label: 'Permissions', description: 'Default workspace permissions' }, { id: 'labels', label: 'Labels', description: 'Labels and auto-apply rules' }] },
  { id: 'account', label: 'Account', items: [{ id: 'preferences', label: 'Preferences', description: 'Name, timezone, location' }, { id: 'security', label: 'Account security', description: 'Password and admin status' }] },
]

export const notifications = [
  { title: 'Skill update available', body: 'Frontend Prototype has a new source-compatible version.', time: '10 min ago', tone: 'info' },
  { title: 'Workspace connected', body: 'Local files permissions were restored for Polo workspace.', time: 'Yesterday', tone: 'good' },
  { title: 'Automation paused', body: 'Stale sessions was paused after three failed runs.', time: 'Mon', tone: 'warning' },
]
