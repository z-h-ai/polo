/**
 * Entry point for the Polo AI WebUI login page.
 * Renders the LoginPage React component into the #root element.
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import LoginPage from './LoginPage'
import './login.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LoginPage />
  </React.StrictMode>,
)
