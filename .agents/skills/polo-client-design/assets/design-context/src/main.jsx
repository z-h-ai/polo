import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app-shell.jsx'
import { installPrototypeRuntime } from './runtime/prototype-runtime.js'
import './styles/tokens.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/regions.css'
import './styles/source-home.css'
import './styles/source-shell.css'
import './styles/source-admin-login.css'

installPrototypeRuntime()
document.documentElement.dataset.prototypeReady = 'true'

createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>,
)
