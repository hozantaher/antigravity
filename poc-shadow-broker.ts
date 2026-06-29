import 'dotenv/config';
import { OpenAI } from 'openai';

// ==========================================
// MOCK DAT (To, co přiteče z poc-deep-inventory)
// ==========================================
const mockArbitrageOpportunity = {
  id: 'auto-847291',
  title: 'Škoda Superb III 2.0 TDI L&K, zachovalé',
  price: 450000,
  marketValue: 520000, // Zjištěno pomocí Brain Heuristiky (Cebia, atd.)
  description: 'Rodinné důvody, spěchá to. Trochu odřený nárazník, jinak top stav.',
  phone: '+420 777 123 456',
  sourceUrl: 'https://auto.bazos.cz/superb',
};

// ==========================================
// 1. SHADOW BROKER (Generátor nabídky)
// ==========================================
async function generateShadowPitch(item: typeof mockArbitrageOpportunity) {
  const apiKey = process.env.RUNPOD_API_KEY || process.env.OPENAI_API_KEY || 'sk-dummy';
  let baseURL = process.env.RUNPOD_URL || process.env.OLLAMA_URL;

  const openai = new OpenAI({ apiKey, baseURL });

  console.log(`\n🤖 [Brain] Analyzuji inzerát a generuji vyjednávací SMS...`);
  
  // Prompt navržen pro asymetrický přístup
  const prompt = `
  Jsi automatizovaný výkupčí aut. Máš za úkol napsat krátkou SMS zprávu (max 160 znaků) prodejci vozu.
  Auto: ${item.title}
  Původní cena inzerátu: ${item.price} Kč
  Popis: "${item.description}"
  
  Nabídneme mu rychlý výkup (peníze ihned na účet). Dej mu najevo, že víš, o jaké auto jde (zmiň detail z popisu). 
  Na konci ho odkaž na "Přikládám link na hotovou výkupní smlouvu: [LINK]".
  Buď slušný, stručný, mírně neformální.
  `;

  try {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }]
      });

      return res.choices[0]?.message?.content || 'Mám zájem o Váš vůz. Nabízím rychlý výkup. [LINK]';
  } catch (e) {
      console.warn("⚠️ LLM API selhalo (asi chybí klíč), používám fallback text.");
      return `Dobrý den, četl jsem, že na prodej ${item.title} spěcháte. Koupím to ihned. Tady máte návrh smlouvy, stačí kliknout: [LINK]`;
  }
}

// ==========================================
// 2. PRIVACY GATEWAY (Generování Magic Linku)
// ==========================================
function generateMagicLink(item: typeof mockArbitrageOpportunity, offerPrice: number) {
  console.log(`🔗 [Hands] Vytvářím Shadow Draft (Magic Link)...`);
  
  // Payload pro Magic Link (v produkci JWT)
  const payload = Buffer.from(JSON.stringify({ 
      id: item.id, 
      o: offerPrice, 
      exp: Date.now() + 1000 * 60 * 60 * 24 // Platnost 24h
  })).toString('base64');

  return `https://vykup.auction24.cz/m/${payload}`;
}

// ==========================================
// 3. SIMULACE (Uživatelská interakce)
// ==========================================
function simulateUserClick(magicLink: string, item: typeof mockArbitrageOpportunity, offerPrice: number) {
    console.log(`\n---------------------------------------------------------`);
    console.log(`📱 [Simulace] Prodejce klikl na Magic Link v SMS...`);
    console.log(`---------------------------------------------------------`);
    
    // Extrakce a dekódování
    const token = magicLink.split('/').pop() || '';
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    
    if (decoded.exp < Date.now()) {
        console.log(`❌ Link vypršel.`);
        return;
    }

    console.log(`
    =================================================
    ✨ AUCTION24 | STÍNOVÁ SMLOUVA (Zobrazeno uživateli)
    =================================================
    Vaše vozidlo: ${item.title}
    Stav: Viděli jsme inzerát na internetu.

    NÁŠ NÁVRH (Závazná nabídka):
    Původní cena:   ${item.price} Kč
    Naše nabídka:   ${decoded.o} Kč  (Marže pro nás zajištěna: ${item.marketValue - decoded.o} Kč)
    
    Výhoda pro Vás: Žádné prohlídky, žádné smlouvání. 
    Peníze odchází do 5 minut přes Stripe na Váš účet.

    [ TLAČÍTKO: AKCEPTOVAT A PŘEVZÍT ${decoded.o} Kč ]
    =================================================
    `);
    
    console.log(`✅ [Závěr] Kdyby uživatel klikl na akceptovat, webhook ve 'spine/sale' okamžitě iniciuje Stripe Settlement a proces je dokončen.`);
}

// ==========================================
// RUN PoC
// ==========================================
async function run() {
    console.log(`🚀 Startuji Shadow Broker Pipeline...`);
    
    const ourOffer = 420000; 

    let smsPitch = await generateShadowPitch(mockArbitrageOpportunity);
    const magicLink = generateMagicLink(mockArbitrageOpportunity, ourOffer);
    
    smsPitch = smsPitch.replace('[LINK]', magicLink);
    
    console.log(`\n📤 [Outreach] Odesílám následující SMS na ${mockArbitrageOpportunity.phone}:`);
    console.log(`"${smsPitch}"`);

    setTimeout(() => {
        simulateUserClick(magicLink, mockArbitrageOpportunity, ourOffer);
    }, 2000);
}

run().catch(console.error);
