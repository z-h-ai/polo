import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app-shell.jsx'
import { MvpAssistant } from './mvp/Assistant.jsx'
import { installReviewBridge } from './mvp/runtime.js'
import './mvp/mvp.css'
import { installPrototypeRuntime } from './runtime/prototype-runtime.js'
import './styles/tokens.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/regions.css'
import './styles/source-shell.css'
import './styles/source-admin-login.css'
import '../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css'

installPrototypeRuntime()
installReviewBridge()
const params = new URLSearchParams(location.search)
const reference = params.get("reference") === "1"
document.documentElement.dataset.prototypeReady = 'true'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>{reference ? <App /> : <MvpAssistant />}</React.StrictMode>,
)
