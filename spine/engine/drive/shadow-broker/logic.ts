import { ArbitrageOpportunity, ShadowDraft } from '../../../domain/core-types';
import crypto from 'crypto';

/**
 * Zpracuje nalezenou arbitráž, vytvoří "Shadow Draft" a zašle prodejci
 * kouzelný link s nabídkou k okamžitému odkupu.
 */
export async function dispatchShadowDraft(
  opportunity: ArbitrageOpportunity,
  dealerEmail: string
): Promise<ShadowDraft> {
  
  // 1. Vytvoření Shadow Draft záznamu
  const draft: ShadowDraft = {
    draftId: crypto.randomUUID(),
    opportunityId: opportunity.id,
    contactEmail: dealerEmail,
    createdAt: new Date().toISOString(),
    status: 'pending'
  };

  // 2. Odeslání e-mailu (Mockováno v testech přes Mailtrap/MSW, v reálu SMTP)
  const magicLink = `https://antigravity.auto/draft/${draft.draftId}`;
  
  // Simulace SMTP call
  const emailPayload = {
    to: dealerEmail,
    subject: `Máme zájem o Váš vůz (ID: ${opportunity.assetId})`,
    body: `Dobrý den,\n\nNašli jsme Váš inzerát a jsme připraveni vůz okamžitě vykoupit za ${opportunity.price} CZK.\n\nKlikněte zde pro potvrzení obchodu: ${magicLink}`
  };

  // Pro PoC účely zde vyhodíme výjimku, pokud není mailtrap namockován
  const response = await fetch('https://api.mailtrap.io/api/send/inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(emailPayload)
  });

  if (!response.ok) {
    throw new Error('Nepodařilo se odeslat email prodejci.');
  }

  return draft;
}
