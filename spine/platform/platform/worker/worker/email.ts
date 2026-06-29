import sgMail from '@sendgrid/mail';

// M8: Replace the boolean flag with a stored promise so concurrent first-callers
// share the same init work instead of each racing to set the flag. For synchronous
// init (setApiKey is sync) this is equivalent in practice, but the promise pattern
// scales correctly if init ever becomes async (e.g. loading a secret from a vault).
let initPromise: Promise<void> | null = null;

const ensureInit = (): Promise<void> => {
  if (!initPromise) {
    initPromise = Promise.resolve().then(() => {
      const key = process.env.SENDGRID_API_KEY;
      if (!key) throw new Error('SENDGRID_API_KEY is required');
      sgMail.setApiKey(key);
    });
  }
  return initPromise;
};

const escapeHtml = (str: string): string =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const sendResultEmail = async (params: {
  to: string;
  firstName: string;
  downloadUrl: string;
  docxUrl: string;
}) => {
  await ensureInit();

  const name = escapeHtml(params.firstName);

  await sgMail.send({
    to: params.to,
    from: process.env.SENDGRID_FROM_EMAIL || 'noreply@rozporuj.com',
    subject: 'Váš odpor proti pokutě je připraven',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Dobrý den, ${name},</h2>
        <p>váš odpor proti pokutě byl úspěšně vygenerován.</p>
        <p>
          <a href="${escapeHtml(params.downloadUrl)}"
             style="display: inline-block; padding: 12px 24px; background: #FF9431; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Stáhnout PDF
          </a>
          &nbsp;&nbsp;
          <a href="${escapeHtml(params.docxUrl)}"
             style="display: inline-block; padding: 12px 24px; background: #333; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Stáhnout DOCX
          </a>
        </p>
        <p style="font-size: 14px; color: #666;">
          Odkazy jsou platné 7 dní. Soubory si také můžete stáhnout na stránce s výsledkem objednávky.
          DOCX verzi můžete před tiskem upravit.
        </p>
        <div style="background: #FFF8F0; border: 1px solid #FFD6A5; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="font-size: 14px; color: #333; margin: 0 0 8px 0;">
            <strong>Před odesláním prosím zkontrolujte:</strong>
          </p>
          <ul style="font-size: 13px; color: #555; margin: 0; padding-left: 20px;">
            <li>Vyhledejte v dokumentu <strong>[DOPLNIT]</strong> a doplňte chybějící údaje (datum doručení, adresu apod.)</li>
            <li>Ověřte, že vaše jméno, adresa a číslo jednací odpovídají skutečnosti</li>
            <li>Zkontrolujte lhůtu pro podání — odpor/námitky musí být podány včas</li>
            <li>Dokument vytiskněte, vlastnoručně podepište a odešlete doporučeně</li>
          </ul>
        </div>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="font-size: 12px; color: #999;">
          <strong>Upozornění:</strong> Tento dokument byl vygenerován s využitím umělé inteligence
          na základě databáze české legislativy a judikatury. Nejedná se o právní poradenství.
          Před použitím doporučujeme revizi kvalifikovaným advokátem.
        </p>
        <p style="font-size: 12px; color: #999;">
          Rozporuj.com &mdash; automatické generování odporů proti pokutám
        </p>
      </div>
    `,
  });
};
