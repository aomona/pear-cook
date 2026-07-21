import { Languages } from "lucide-react";

import { useI18n, type Locale } from "./i18n";

export function LanguageSelector({ compact = false }: { compact?: boolean }) {
  const { locale, messages, setLocale } = useI18n();

  return (
    <label className={`language-selector${compact ? " language-selector-compact" : ""}`}>
      <Languages aria-hidden="true" />
      <span className="sr-only">{messages.common.language}</span>
      <select
        aria-label={messages.common.language}
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        <option value="ja">{messages.common.japanese}</option>
        <option value="en">{messages.common.english}</option>
      </select>
    </label>
  );
}
