import React, { useState } from 'react'
import { Plus } from 'lucide-react'

// Source: apps/electron/src/renderer/components/tab-browser/HomePage.tsx and
// AppIcon.tsx. This is its fresh-profile fixture: no recents and no active
// organization. All visible strings come from packages/shared i18n keys.
export function SourceHomeLauncher({ poloIconSrc, onOpenPolo = () => {}, onAddExternalApp = () => {} }) {
  return <main data-testid="home-app-hub" className="source-home">
    <div className="source-home__content">
      <section aria-labelledby="recent-apps-heading">
        <div className="source-home__heading">
          <div>
            <h1 id="recent-apps-heading">Recently used</h1>
            <p>Jump back into your Polo apps and recent work.</p>
          </div>
        </div>
        {/* In the fresh-profile source fixture the recent-app grid is empty. */}
        <div className="source-home__builtin" data-testid="builtin-app-launcher">
          <h2>Built-in apps</h2>
          <p>Built-in Polo tools remain available on this device.</p>
          <div className="source-home__grid source-home__grid--builtin">
            <SourceAppIcon app={{ id: 'polo-ai', name: 'Polo 助手', type: 'builtin' }} poloIconSrc={poloIconSrc} onClick={onOpenPolo}/>
          </div>
        </div>
      </section>
      <section aria-labelledby="external-apps-heading">
        <div className="source-home__heading">
          <div>
            <h2 id="external-apps-heading">External apps</h2>
            <p>Personal website shortcuts stored only on this device.</p>
          </div>
        </div>
        <div className="source-home__grid"><AddExternalAppTile onClick={onAddExternalApp}/></div>
      </section>
    </div>
  </main>
}

function SourceAppIcon({ app, poloIconSrc, onClick }) {
  const [hovered, setHovered] = useState(false)
  return <button type="button" aria-label={app.name} onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} className={'source-app-icon' + (hovered ? ' is-hovered' : '')}>
    <span className="source-app-icon__art"><img src={poloIconSrc} alt=""/></span>
    <span className="source-app-icon__label">{app.name}</span>
  </button>
}

function AddExternalAppTile({ onClick }) {
  const [hovered, setHovered] = useState(false)
  return <button type="button" data-testid="add-external-app" onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} className={'source-app-icon' + (hovered ? ' is-hovered' : '')}>
    <span className="source-app-icon__art source-app-icon__art--add"><Plus aria-hidden="true" size={32} strokeWidth={1.5}/></span>
    <span className="source-app-icon__label source-app-icon__label--add">Add external app</span>
  </button>
}
