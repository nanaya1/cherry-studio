import '@renderer/assets/styles/tailwind.css'
import './login.css'
import i18n from 'i18next'
import { createRoot } from 'react-dom/client'
import { initReactI18next } from 'react-i18next'

import ProfileBootstrapApp from './ProfileBootstrapApp'

// MEA:profile-verification-network-tolerance Bootstrap localization must not initialize business IPC or preferences.
const locales = import.meta.glob('../../i18n/locales/*.json', { import: 'default' })
const requested = navigator.language.toLowerCase()
const language = `../../i18n/locales/${requested}.json` in locales ? requested : 'en-us'
const fallback = await locales['../../i18n/locales/en-us.json']()
const translation = language === 'en-us' ? fallback : await locales[`../../i18n/locales/${language}.json`]()
await i18n.use(initReactI18next).init({
  lng: language,
  fallbackLng: 'en-us',
  keySeparator: false,
  resources: {
    'en-us': { translation: fallback as Record<string, string> },
    [language]: { translation: translation as Record<string, string> }
  },
  interpolation: { escapeValue: false }
})

// 引导窗口不初始化业务偏好和数据服务。
createRoot(document.getElementById('root') as HTMLElement).render(<ProfileBootstrapApp />)
