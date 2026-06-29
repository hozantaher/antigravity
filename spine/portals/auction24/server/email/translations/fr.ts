import type { LayoutStrings } from '../layout'
import type { TemplateStrings } from '../templates'

const translation: { layout: LayoutStrings; templates: TemplateStrings } = {
  layout: {
    contactIntro: "Si vous avez des questions, n'hésitez pas à nous contacter :",
    contactInfo: '+420 608 708 258 | INFO@AUCTION24.CZ',
    regards: 'Cordialement,',
    team: "L'équipe Auction24",
    tagline: 'Enchères en ligne, 24 heures sur 24, 7 jours sur 7.',
  },
  templates: {
    sendVerificationEmail: {
      subject: 'Vérifiez votre adresse e-mail',
      heading: "Vérification de l'adresse e-mail",
      body1:
        'Pour finaliser votre inscription, veuillez confirmer votre adresse e-mail en cliquant sur le bouton ci-dessous.',
      cta: "Vérifier l'e-mail",
    },
    resetPassword: {
      subject: 'Réinitialisation du mot de passe',
      heading: 'Réinitialisation du mot de passe',
      body1: 'Nous avons reçu une demande de réinitialisation de votre mot de passe.',
      body2:
        "Si vous n'avez pas demandé la réinitialisation de votre mot de passe, vous pouvez ignorer cet e-mail en toute sécurité.",
      cta: 'Réinitialiser le mot de passe',
    },
    auctionWon: {
      subject: "Vous avez remporté l'enchère : {item}",
      heading: 'Félicitations, vous avez gagné !',
      body1: 'Votre offre de {amount} était la plus élevée pour l’enchère « {item} » — vous l’avez remportée.',
      body2:
        'Nous vous contacterons prochainement au sujet des prochaines étapes. Vous pouvez consulter les détails de l’enchère ci-dessous.',
      cta: "Voir l'enchère",
    },
    depositPaid: {
      subject: 'Votre caution a été reçue',
      heading: 'Caution reçue',
      body1: 'Nous avons bien reçu votre caution de {amount}. Vous pouvez désormais enchérir sur toutes les enchères.',
      body2: 'La caution est entièrement remboursable. Vous pouvez consulter son statut actuel dans votre profil.',
      cta: 'Voir le profil',
    },
    salePaid: {
      subject: 'Paiement reçu pour {item}',
      heading: 'Achat finalisé',
      body1: 'Nous avons reçu votre paiement de {amount} pour « {item} ». Votre achat est maintenant finalisé.',
      body2: 'La facture a été envoyée à votre adresse e-mail. Merci pour votre achat !',
      cta: 'Voir l’article',
    },
    newsletter: {
      subject: 'Des véhicules sélectionnés pour vous',
      heading: 'Véhicules recommandés',
      intro: 'Nous avons sélectionné quelques enchères qui pourraient vous intéresser.',
      endsLabel: 'Se termine :',
      viewLabel: "Voir l'annonce",
      unsubscribe: 'Se désabonner de la newsletter',
    },
    savedSearchAlert: {
      subject: 'Nouveaux résultats pour « {name} »',
      heading: 'Nouveaux résultats pour votre recherche enregistrée',
      intro: 'Voici les dernières annonces correspondant à la recherche « {name} ».',
      endsLabel: 'Se termine :',
      viewLabel: "Voir l'annonce",
      unsubscribe: 'Désactiver les alertes pour cette recherche',
    },
  },
}

export default translation
