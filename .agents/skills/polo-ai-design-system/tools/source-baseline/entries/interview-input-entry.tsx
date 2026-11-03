// Match the baseline's mock-before-renderer ordering without loading unrelated scenes.
import '@/playground/mock-utils'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { setupI18n } from '@polo-ai/shared/i18n'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { InterviewInputScene } from './interview-input'
import './baseline.css'

setupI18n([initReactI18next])
void i18n.changeLanguage('zh-Hans')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><InterviewInputScene /></React.StrictMode>,
)
