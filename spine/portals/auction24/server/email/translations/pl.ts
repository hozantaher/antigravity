import type { LayoutStrings } from '../layout'
import type { TemplateStrings } from '../templates'

const translation: { layout: LayoutStrings; templates: TemplateStrings } = {
  layout: {
    contactIntro: 'W razie pytań prosimy o kontakt:',
    contactInfo: '+420 608 708 258 | INFO@AUCTION24.CZ',
    regards: 'Z poważaniem,',
    team: 'Zespół Auction24',
    tagline: 'Aukcje online, 24 godziny na dobę, 7 dni w tygodniu.',
  },
  templates: {
    sendVerificationEmail: {
      subject: 'Weryfikacja adresu e-mail',
      heading: 'Weryfikacja adresu e-mail',
      body1:
        'Aby dokończyć rejestrację, prosimy o potwierdzenie adresu e-mail poprzez kliknięcie poniższego przycisku.',
      cta: 'Zweryfikuj e-mail',
    },
    resetPassword: {
      subject: 'Resetowanie hasła',
      heading: 'Resetowanie hasła',
      body1: 'Otrzymaliśmy prośbę o zresetowanie Państwa hasła.',
      body2: 'Jeśli nie składali Państwo takiej prośby, prosimy zignorować tę wiadomość.',
      cta: 'Zresetuj hasło',
    },
    auctionWon: {
      subject: 'Wygrałeś aukcję: {item}',
      heading: 'Gratulacje, wygrałeś!',
      body1: 'Twoja oferta {amount} była najwyższa w aukcji „{item}“ — wygrałeś.',
      body2: 'Wkrótce skontaktujemy się z Tobą w sprawie dalszych kroków. Szczegóły aukcji zobaczysz poniżej.',
      cta: 'Zobacz aukcję',
    },
    depositPaid: {
      subject: 'Twoja kaucja została przyjęta',
      heading: 'Kaucja przyjęta',
      body1: 'Pomyślnie otrzymaliśmy Twoją kaucję w wysokości {amount}. Możesz teraz licytować we wszystkich aukcjach.',
      body2: 'Kaucja jest w pełni zwrotna. Jej aktualny status sprawdzisz w swoim profilu.',
      cta: 'Zobacz profil',
    },
    salePaid: {
      subject: 'Płatność otrzymana za {item}',
      heading: 'Zakup zakończony',
      body1: 'Otrzymaliśmy Twoją płatność w wysokości {amount} za „{item}”. Twój zakup został zakończony.',
      body2: 'Faktura została wysłana na Twój adres e-mail. Dziękujemy za zakup!',
      cta: 'Zobacz przedmiot',
    },
    newsletter: {
      subject: 'Pojazdy wybrane dla Ciebie',
      heading: 'Polecane pojazdy',
      intro: 'Wybraliśmy kilka aukcji, które mogą Cię zainteresować.',
      endsLabel: 'Koniec:',
      viewLabel: 'Zobacz ogłoszenie',
      unsubscribe: 'Wypisz się z newslettera',
    },
    savedSearchAlert: {
      subject: 'Nowe wyniki dla „{name}”',
      heading: 'Nowe wyniki dla Twojego zapisanego wyszukiwania',
      intro: 'Oto najnowsze ogłoszenia pasujące do wyszukiwania „{name}”.',
      endsLabel: 'Koniec:',
      viewLabel: 'Zobacz ogłoszenie',
      unsubscribe: 'Wyłącz powiadomienia dla tego wyszukiwania',
    },
  },
}

export default translation
