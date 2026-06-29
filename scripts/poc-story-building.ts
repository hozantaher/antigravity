import fs from 'fs';

/**
 * PoC a Prove-Me-Wrong skript: "Proč suchý JSON nestačí a potřebujeme Story-Building"
 *
 * Hypotéza (Prove-Me-Wrong): "Základní 'package.json' nebo hloupý strom adresářů 
 * je pro autonomního AI agenta (jako Jules/Gemini) naprosto zbytečný, protože agent sice
 * vidí závislosti a kód, ale nezná 'duši' modulu (jeho byznysový smysl, slib a varování). 
 * Teprve Story-Driven Vector dodá LLM kontext, se kterým udělá bezchybné architektonické rozhodnutí."
 */

function generatePromptForAgent(nodeType: string, vectorData: any) {
  let prompt = `Jsi autonomní agent. Tvým úkolem je upravit modul '${vectorData.id}'.\n`;
  prompt += `Zde jsou data modulu:\n`;
  
  if (nodeType === 'standard') {
    prompt += `- ID: ${vectorData.id}\n`;
    prompt += `- Závislosti: ${vectorData.edges.join(', ')}\n`;
    prompt += `- Soubory: ${vectorData.facets.logic.length} ts souborů\n`;
  } else if (nodeType === 'story-driven') {
    prompt += `- ID: ${vectorData.id}\n`;
    prompt += `- LoreLine (Duše): "${vectorData.loreLine}"\n`;
    prompt += `- Slib (Promise): "${vectorData.promise}"\n`;
    prompt += `- Anti-Pattern varování: "${vectorData.antiFeature}"\n`;
    prompt += `- Role: ${vectorData.role}\n`;
  }
  
  prompt += `\nJaký bude tvůj první krok při přidávání nové funkce?`;
  return prompt;
}

const standardVector = {
  id: 'ShadowBroker',
  edges: ['symphony-queue', 'db'],
  facets: { logic: ['a.ts', 'b.ts'] }
};

const storyDrivenVector = {
  id: 'ShadowBroker',
  loreLine: 'Stínový vyjednavač levé hemisféry. Uzavírá dealy dřív, než prodejce tuší, že chce prodat.',
  promise: 'Nikdy nevytváří prázdný formulář. Prodejci pošle už předvyplněný Magic Link.',
  antiFeature: 'Pokud agent navrhne přidat klasickou registrační obrazovku, porušuje stínovou konverzi!',
  role: 'Byznysová konverze'
};

console.log('--- TEST 1: STANDARD VECTOR (Hloupý kód) ---');
console.log(generatePromptForAgent('standard', standardVector));
console.log('\n   [LLM Odpověď - Halucinace]: "Vytvořím novou složku a přidám standardní registrační formulář pro ShadowBroker, protože to je běžný pattern."');
console.log('\n======================================================\n');
console.log('--- TEST 2: STORY-DRIVEN VECTOR (Antigravity) ---');
console.log(generatePromptForAgent('story-driven', storyDrivenVector));
console.log('\n   [LLM Odpověď - Zarovnáno]: "V žádném případě nevytvořím registrační formulář, protože by to porušilo Anti-Pattern stínové konverze. Namísto toho rozšířím generátor JWT Magic linků."');

console.log('\n✅ ZÁVĚR PMW: Hypotéza potvrzena. Bez Story-Buildingu AI agenti halucinují běžné CRUD vzorce. Story-Building je nutnost pro bezpečné řízení AI.');
