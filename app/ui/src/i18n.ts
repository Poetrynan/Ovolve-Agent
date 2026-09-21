import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import zh from './locales/zh.json'
import en from './locales/en.json'

export const SUPPORTED_LANGUAGES = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
] as const

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code']

// `init()` is async but there is nothing to await at module scope, and
// react-i18next renders against the resources synchronously once they land.
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      zh: { translation: zh },
      en: { translation: en },
    },
    fallbackLng: 'zh',
    supportedLngs: ['zh', 'en'],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'ovolve-lang',
      caches: ['localStorage'],
    },
  })

export default i18n
