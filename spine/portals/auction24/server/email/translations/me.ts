import type { LayoutStrings } from '../layout'
import type { TemplateStrings } from '../templates'

const translation: { layout: LayoutStrings; templates: TemplateStrings } = {
  layout: {
    contactIntro: 'Ako imate bilo kakvih pitanja, slobodno nas kontaktirajte:',
    contactInfo: '+420 608 708 258 | INFO@AUCTION24.CZ',
    regards: 'Srdačan pozdrav,',
    team: 'Tim Auction24',
    tagline: 'Online aukcije, 24 sata dnevno, 7 dana u nedjelji.',
  },
  templates: {
    sendVerificationEmail: {
      subject: 'Potvrdite svoju e-mail adresu',
      heading: 'Potvrda e-mail adrese',
      body1: 'Za završetak registracije, molimo potvrdite svoju e-mail adresu klikom na dugme ispod.',
      cta: 'Potvrdi e-mail',
    },
    resetPassword: {
      subject: 'Promjena lozinke',
      heading: 'Promjena lozinke',
      body1: 'Primili smo zahtjev za promjenu vaše lozinke.',
      body2: 'Ako nijeste tražili promjenu lozinke, slobodno zanemarite ovu poruku.',
      cta: 'Promijeni lozinku',
    },
    auctionWon: {
      subject: 'Osvojili ste aukciju: {item}',
      heading: 'Čestitamo, pobijedili ste!',
      body1: 'Vaša ponuda od {amount} bila je najviša na aukciji „{item}“ — pobijedili ste.',
      body2: 'Uskoro ćemo vas kontaktirati u vezi sa sljedećim koracima. Detalje aukcije možete pogledati ispod.',
      cta: 'Pogledaj aukciju',
    },
    depositPaid: {
      subject: 'Vaš depozit je primljen',
      heading: 'Depozit primljen',
      body1: 'Uspješno smo primili Vaš depozit u iznosu od {amount}. Sada možete licitirati na svim aukcijama.',
      body2: 'Depozit se u potpunosti vraća. Trenutni status možete provjeriti u svom profilu.',
      cta: 'Pogledaj profil',
    },
    salePaid: {
      subject: 'Plaćanje primljeno za {item}',
      heading: 'Kupovina završena',
      body1: 'Primili smo vašu uplatu od {amount} za „{item}“. Vaša kupovina je sada završena.',
      body2: 'Račun je poslat na vašu e-poštu. Hvala na kupovini!',
      cta: 'Pogledaj predmet',
    },
    newsletter: {
      subject: 'Vozila odabrana za vas',
      heading: 'Preporučena vozila',
      intro: 'Odabrali smo nekoliko aukcija koje bi vas mogle zanimati.',
      endsLabel: 'Završava:',
      viewLabel: 'Pogledaj oglas',
      unsubscribe: 'Odjavi se sa newslettera',
    },
    savedSearchAlert: {
      subject: 'Novi rezultati za „{name}“',
      heading: 'Novi rezultati za vašu sačuvanu pretragu',
      intro: 'Evo najnovijih oglasa koji odgovaraju pretrazi „{name}“.',
      endsLabel: 'Završava:',
      viewLabel: 'Pogledaj oglas',
      unsubscribe: 'Isključi obavještenja za ovu pretragu',
    },
  },
}

export default translation
