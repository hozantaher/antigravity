import type { LayoutStrings } from '../layout'
import type { TemplateStrings } from '../templates'

const translation: { layout: LayoutStrings; templates: TemplateStrings } = {
  layout: {
    contactIntro: "If you have any questions, don't hesitate to contact us:",
    contactInfo: '+420 608 708 258 | INFO@AUCTION24.CZ',
    regards: 'Best regards,',
    team: 'The Auction24 Team',
    tagline: 'Online auctions, 24 hours a day, 7 days a week.',
  },
  templates: {
    sendVerificationEmail: {
      subject: 'Verify your email',
      heading: 'Email verification',
      body1: 'To complete your registration, please confirm your email address by clicking the button below.',
      cta: 'Verify email',
    },
    resetPassword: {
      subject: 'Password reset',
      heading: 'Password reset',
      body1: 'We received a request to reset your password.',
      body2: 'If you did not request a password reset, you can safely ignore this email.',
      cta: 'Reset password',
    },
    auctionWon: {
      subject: 'You won the auction: {item}',
      heading: 'Congratulations, you won!',
      body1: 'Your bid of {amount} was the highest in the auction “{item}” — you won.',
      body2: "We'll be in touch shortly about the next steps. You can review the auction details below.",
      cta: 'View auction',
    },
    depositPaid: {
      subject: 'Your deposit has been received',
      heading: 'Deposit received',
      body1: 'We have successfully received your deposit of {amount}. You can now place bids in all auctions.',
      body2: 'The deposit is fully refundable. You can check its current status in your profile.',
      cta: 'View profile',
    },
    salePaid: {
      subject: 'Payment received for {item}',
      heading: 'Purchase complete',
      body1: 'We have received your payment of {amount} for “{item}”. Your purchase is now complete.',
      body2: 'The invoice has been sent to your e-mail. Thank you for your purchase!',
      cta: 'View the item',
    },
    newsletter: {
      subject: 'Vehicles picked for you',
      heading: 'Recommended vehicles',
      intro: 'We picked a few auctions you might like.',
      endsLabel: 'Ends:',
      viewLabel: 'View listing',
      unsubscribe: 'Unsubscribe from the newsletter',
    },
    savedSearchAlert: {
      subject: 'New matches for “{name}”',
      heading: 'New matches for your saved search',
      intro: 'Here are the latest listings matching “{name}”.',
      endsLabel: 'Ends:',
      viewLabel: 'View listing',
      unsubscribe: 'Stop alerts for this saved search',
    },
  },
}

export default translation
