import type { LayoutStrings } from '../layout'
import type { TemplateStrings } from '../templates'

const translation: { layout: LayoutStrings; templates: TemplateStrings } = {
  layout: {
    contactIntro: 'Bei Fragen stehen wir Ihnen gerne zur Verfügung:',
    contactInfo: '+420 608 708 258 | INFO@AUCTION24.CZ',
    regards: 'Mit freundlichen Grüßen,',
    team: 'Das Auction24-Team',
    tagline: 'Online-Auktionen, 24 Stunden am Tag, 7 Tage die Woche.',
  },
  templates: {
    sendVerificationEmail: {
      subject: 'E-Mail-Adresse bestätigen',
      heading: 'E-Mail-Verifizierung',
      body1:
        'Um Ihre Registrierung abzuschließen, bestätigen Sie bitte Ihre E-Mail-Adresse, indem Sie auf die Schaltfläche unten klicken.',
      cta: 'E-Mail bestätigen',
    },
    resetPassword: {
      subject: 'Passwort zurücksetzen',
      heading: 'Passwort zurücksetzen',
      body1: 'Wir haben eine Anfrage zum Zurücksetzen Ihres Passworts erhalten.',
      body2: 'Falls Sie kein Zurücksetzen des Passworts angefordert haben, können Sie diese E-Mail ignorieren.',
      cta: 'Passwort zurücksetzen',
    },
    auctionWon: {
      subject: 'Sie haben die Auktion gewonnen: {item}',
      heading: 'Herzlichen Glückwunsch, Sie haben gewonnen!',
      body1: 'Ihr Gebot von {amount} war das höchste in der Auktion „{item}“ — Sie haben gewonnen.',
      body2:
        'Wir melden uns in Kürze bezüglich der nächsten Schritte. Die Auktionsdetails sehen Sie über die Schaltfläche unten.',
      cta: 'Auktion ansehen',
    },
    depositPaid: {
      subject: 'Ihre Kaution ist eingegangen',
      heading: 'Kaution eingegangen',
      body1:
        'Wir haben Ihre Kaution in Höhe von {amount} erfolgreich erhalten. Sie können nun bei allen Auktionen mitbieten.',
      body2: 'Die Kaution ist vollständig erstattungsfähig. Den aktuellen Status finden Sie in Ihrem Profil.',
      cta: 'Profil ansehen',
    },
    salePaid: {
      subject: 'Zahlung erhalten für {item}',
      heading: 'Kauf abgeschlossen',
      body1: 'Wir haben Ihre Zahlung in Höhe von {amount} für „{item}“ erhalten. Ihr Kauf ist nun abgeschlossen.',
      body2: 'Die Rechnung wurde an Ihre E-Mail-Adresse gesendet. Vielen Dank für Ihren Kauf!',
      cta: 'Artikel ansehen',
    },
    newsletter: {
      subject: 'Für Sie ausgewählte Fahrzeuge',
      heading: 'Empfohlene Fahrzeuge',
      intro: 'Wir haben einige Auktionen ausgewählt, die Ihnen gefallen könnten.',
      endsLabel: 'Endet:',
      viewLabel: 'Anzeige ansehen',
      unsubscribe: 'Newsletter abbestellen',
    },
    savedSearchAlert: {
      subject: 'Neue Treffer für „{name}“',
      heading: 'Neue Treffer für Ihre gespeicherte Suche',
      intro: 'Hier sind die neuesten Anzeigen, die zur Suche „{name}“ passen.',
      endsLabel: 'Endet:',
      viewLabel: 'Anzeige ansehen',
      unsubscribe: 'Benachrichtigungen für diese Suche deaktivieren',
    },
  },
}

export default translation
