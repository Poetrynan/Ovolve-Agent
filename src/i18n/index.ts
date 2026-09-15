import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zh } from './zh';
import { en } from './en';

export type Locale = 'zh' | 'en';
export type TranslationKey = keyof typeof zh;

const dictionaries: Record<Locale, Record<string, string>> = {
  zh,
  en,
};

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set, get) => ({
      locale: 'zh', // Default to Chinese as requested

      setLocale: (locale: Locale) => {
        set({ locale });
      },

      t: (key: TranslationKey, params?: Record<string, string | number>) => {
        const { locale } = get();
        const dict = dictionaries[locale] || dictionaries.zh;
        let text = dict[key] || dictionaries.en[key] || key;

        if (params) {
          Object.entries(params).forEach(([k, v]) => {
            text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          });
        }
        return text;
      },
    }),
    {
      name: 'ovolveAgent.locale',
      partialize: (state) => ({ locale: state.locale }),
    }
  )
);

export const useI18n = () => {
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const t = useLocaleStore((s) => s.t);
  return { locale, setLocale, t };
};

export { zh, en };
