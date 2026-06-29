import type { LayoutStrings } from '../layout'
import type { TemplateStrings } from '../templates'

const translation: { layout: LayoutStrings; templates: TemplateStrings } = {
  layout: {
    contactIntro: 'Máte-li jakékoliv dotazy, neváhejte nás kontaktovat:',
    contactInfo: '+420 608 708 258 | INFO@AUCTION24.CZ',
    regards: 'S pozdravem,',
    team: 'Tým Auction24',
    tagline: 'Online aukce, 24 hodin denně, 7 dní v týdnu.',
  },
  templates: {
    sendVerificationEmail: {
      subject: 'Ověřte svůj e-mail',
      heading: 'Ověření e-mailové adresy',
      body1: 'Pro dokončení registrace prosím potvrďte svou e-mailovou adresu kliknutím na tlačítko níže.',
      cta: 'Ověřit e-mail',
    },
    resetPassword: {
      subject: 'Obnovení hesla',
      heading: 'Obnovení hesla',
      body1: 'Obdrželi jsme žádost o obnovení vašeho hesla.',
      body2: 'Pokud jste o obnovení nežádali, tento e-mail ignorujte.',
      cta: 'Obnovit heslo',
    },
    auctionWon: {
      subject: 'Vyhráli jste aukci: {item}',
      heading: 'Gratulujeme, vyhráli jste!',
      body1: 'Vaše nabídka {amount} byla v aukci „{item}“ nejvyšší — vyhráli jste.',
      body2: 'Brzy vás budeme kontaktovat ohledně dalšího postupu. Detaily aukce zobrazíte tlačítkem níže.',
      cta: 'Zobrazit aukci',
    },
    depositPaid: {
      subject: 'Vaše kauce byla přijata',
      heading: 'Kauce uhrazena',
      body1: 'Vaši kauci ve výši {amount} jsme úspěšně přijali. Nyní můžete přihazovat ve všech aukcích.',
      body2: 'Kauce je plně vratná. Její aktuální stav najdete ve svém profilu.',
      cta: 'Zobrazit profil',
    },
    salePaid: {
      subject: 'Platba přijata za {item}',
      heading: 'Nákup dokončen',
      body1: 'Vaši platbu ve výši {amount} za „{item}“ jsme přijali. Váš nákup je nyní dokončen.',
      body2: 'Fakturu jsme vám zaslali e-mailem. Děkujeme za nákup!',
      cta: 'Zobrazit položku',
    },
    newsletter: {
      subject: 'Vozidla vybraná pro vás',
      heading: 'Doporučená vozidla',
      intro: 'Vybrali jsme pár aukcí, které by vás mohly zajímat.',
      endsLabel: 'Končí:',
      viewLabel: 'Zobrazit inzerát',
      unsubscribe: 'Odhlásit odběr newsletteru',
    },
    savedSearchAlert: {
      subject: 'Nové nabídky pro „{name}“',
      heading: 'Nové nabídky pro vaše uložené hledání',
      intro: 'Zde jsou nejnovější inzeráty odpovídající hledání „{name}“.',
      endsLabel: 'Končí:',
      viewLabel: 'Zobrazit inzerát',
      unsubscribe: 'Zrušit upozornění pro toto hledání',
    },
  },
}

export default translation
