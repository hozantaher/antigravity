import type { LayoutStrings } from '../layout'
import type { TemplateStrings } from '../templates'

const translation: { layout: LayoutStrings; templates: TemplateStrings } = {
  layout: {
    contactIntro: 'Heeft u vragen? Neem gerust contact met ons op:',
    contactInfo: '+420 608 708 258 | INFO@AUCTION24.CZ',
    regards: 'Met vriendelijke groet,',
    team: 'Het Auction24-team',
    tagline: 'Online veilingen, 24 uur per dag, 7 dagen per week.',
  },
  templates: {
    sendVerificationEmail: {
      subject: 'Bevestig uw e-mailadres',
      heading: 'E-mailverificatie',
      body1: 'Om uw registratie te voltooien, bevestigt u uw e-mailadres door op de onderstaande knop te klikken.',
      cta: 'E-mail bevestigen',
    },
    resetPassword: {
      subject: 'Wachtwoord herstellen',
      heading: 'Wachtwoord herstellen',
      body1: 'Wij hebben een verzoek ontvangen om uw wachtwoord te herstellen.',
      body2: 'Als u geen wachtwoordherstel heeft aangevraagd, kunt u deze e-mail veilig negeren.',
      cta: 'Wachtwoord herstellen',
    },
    auctionWon: {
      subject: 'U hebt de veiling gewonnen: {item}',
      heading: 'Gefeliciteerd, u hebt gewonnen!',
      body1: 'Uw bod van {amount} was het hoogste in de veiling “{item}” — u hebt gewonnen.',
      body2: 'We nemen binnenkort contact met u op over de volgende stappen. De veilingdetails vindt u hieronder.',
      cta: 'Veiling bekijken',
    },
    depositPaid: {
      subject: 'Uw borg is ontvangen',
      heading: 'Borg ontvangen',
      body1: 'Wij hebben uw borg van {amount} succesvol ontvangen. U kunt nu bieden op alle veilingen.',
      body2: 'De borg is volledig terugbetaalbaar. U kunt de actuele status in uw profiel bekijken.',
      cta: 'Profiel bekijken',
    },
    salePaid: {
      subject: 'Betaling ontvangen voor {item}',
      heading: 'Aankoop voltooid',
      body1: 'We hebben uw betaling van {amount} voor “{item}” ontvangen. Uw aankoop is nu voltooid.',
      body2: 'De factuur is naar uw e-mailadres verzonden. Bedankt voor uw aankoop!',
      cta: 'Bekijk het item',
    },
    newsletter: {
      subject: 'Voertuigen voor u geselecteerd',
      heading: 'Aanbevolen voertuigen',
      intro: 'We hebben een aantal veilingen geselecteerd die u mogelijk interesseren.',
      endsLabel: 'Eindigt:',
      viewLabel: 'Advertentie bekijken',
      unsubscribe: 'Uitschrijven voor de nieuwsbrief',
    },
    savedSearchAlert: {
      subject: 'Nieuwe resultaten voor “{name}”',
      heading: 'Nieuwe resultaten voor uw opgeslagen zoekopdracht',
      intro: 'Hier zijn de nieuwste advertenties die overeenkomen met “{name}”.',
      endsLabel: 'Eindigt:',
      viewLabel: 'Advertentie bekijken',
      unsubscribe: 'Meldingen voor deze zoekopdracht stoppen',
    },
  },
}

export default translation
