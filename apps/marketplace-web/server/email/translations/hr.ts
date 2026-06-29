import type { LayoutStrings } from '../layout'
import type { TemplateStrings } from '../templates'

const translation: { layout: LayoutStrings; templates: TemplateStrings } = {
  layout: {
    contactIntro: 'Ako imate bilo kakvih pitanja, slobodno nas kontaktirajte:',
    contactInfo: '+420 608 708 258 | INFO@AUCTION24.CZ',
    regards: 'Srdačan pozdrav,',
    team: 'Tim Auction24',
    tagline: 'Online aukcije, 24 sata dnevno, 7 dana u tjednu.',
  },
  templates: {
    sendVerificationEmail: {
      subject: 'Potvrdite svoju e-mail adresu',
      heading: 'Potvrda e-mail adrese',
      body1: 'Za dovršetak registracije, molimo potvrdite svoju e-mail adresu klikom na gumb ispod.',
      cta: 'Potvrdi e-mail',
    },
    resetPassword: {
      subject: 'Promjena lozinke',
      heading: 'Promjena lozinke',
      body1: 'Primili smo zahtjev za promjenu vaše lozinke.',
      body2: 'Ako niste zatražili promjenu lozinke, slobodno zanemarite ovu poruku.',
      cta: 'Promijeni lozinku',
    },
    auctionWon: {
      subject: 'Osvojili ste aukciju: {item}',
      heading: 'Čestitamo, pobijedili ste!',
      body1: 'Vaša ponuda od {amount} bila je najviša na aukciji „{item}“ — pobijedili ste.',
      body2: 'Uskoro ćemo vas kontaktirati u vezi sljedećih koraka. Pojedinosti aukcije možete pogledati u nastavku.',
      cta: 'Pogledaj aukciju',
    },
    depositPaid: {
      subject: 'Vaš polog je primljen',
      heading: 'Polog primljen',
      body1: 'Uspješno smo primili Vaš polog u iznosu od {amount}. Sada možete licitirati na svim aukcijama.',
      body2: 'Polog je u potpunosti povratan. Trenutni status možete provjeriti u svom profilu.',
      cta: 'Pogledaj profil',
    },
    salePaid: {
      subject: 'Plaćanje zaprimljeno za {item}',
      heading: 'Kupnja dovršena',
      body1: 'Zaprimili smo vašu uplatu od {amount} za „{item}“. Vaša kupnja je sada dovršena.',
      body2: 'Račun je poslan na vašu e-poštu. Hvala na kupnji!',
      cta: 'Pogledaj artikl',
    },
    newsletter: {
      subject: 'Vozila odabrana za vas',
      heading: 'Preporučena vozila',
      intro: 'Odabrali smo nekoliko aukcija koje bi vas mogle zanimati.',
      endsLabel: 'Završava:',
      viewLabel: 'Pogledaj oglas',
      unsubscribe: 'Odjavi se s newslettera',
    },
    savedSearchAlert: {
      subject: 'Novi rezultati za „{name}“',
      heading: 'Novi rezultati za vaše spremljeno pretraživanje',
      intro: 'Evo najnovijih oglasa koji odgovaraju pretraživanju „{name}“.',
      endsLabel: 'Završava:',
      viewLabel: 'Pogledaj oglas',
      unsubscribe: 'Isključi obavijesti za ovo pretraživanje',
    },
  },
}

export default translation
