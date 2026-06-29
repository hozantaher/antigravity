import type { LayoutStrings } from '../layout'
import type { TemplateStrings } from '../templates'

import cz from './cz'
import en from './en'
import de from './de'
import fr from './fr'
import pl from './pl'
import nl from './nl'
import ru from './ru'
import ua from './ua'
import hr from './hr'
import rs from './rs'
import me from './me'
import ar from './ar'

export interface EmailTranslation {
  layout: LayoutStrings
  templates: TemplateStrings
}

const TRANSLATIONS: Record<string, EmailTranslation> = { cz, en, de, fr, pl, nl, ru, ua, hr, rs, me, ar }

// Locale codes a server e-mail can actually be rendered in (drives resolveRequestLocale).
export const EMAIL_LOCALES = Object.keys(TRANSLATIONS)

// Unknown / unsupported codes fall back to English (the most broadly readable).
export const getTranslation = (language: string): EmailTranslation => TRANSLATIONS[language.toLowerCase()] ?? en
