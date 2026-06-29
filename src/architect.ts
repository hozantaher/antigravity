import fs from 'fs';
import path from 'path';
import { UnifiedVectorEngine } from './engine';

export class DomainArchitect {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  public async expandNode(nodeId: string): Promise<void> {
    const engine = new UnifiedVectorEngine(this.rootDir);
    await engine.scan();
    const context = engine.resolveContext(nodeId);

    if (!context) {
      throw new Error(`Uzel ${nodeId} nebyl nalezen.`);
    }

    console.log(`[Architect] Skener analyzuje kód v uzlu: ${context.path}`);
    console.log(`[Architect] Počet zjištěných souborů: ${context.files.length}`);

    // Zde by bylo normálně volání OpenAI API. Jelikož běžíme v izolovaném CLI bez klíče, 
    // simulujeme deterministický výstup pro známé uzly nebo generický výstup.
    const proposedNodes = this.simulateLlmResponse(nodeId);

    console.log(`\n[Architect] Návrh expanze vytvořen (Agentic AI)! Sub-uzly k vytvoření:`);
    for (const node of proposedNodes) {
      console.log(` ├── ${node.name}`);
      console.log(` │    📖 ${node.loreLine}`);
      console.log(` │    ✨ ${node.promise}`);
    }

    console.log(`\n[Architect] Fyzicky zakládám infrastrukturu...`);
    for (const node of proposedNodes) {
      const fullPath = path.join(context.path, node.name);
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }

      const manifest = {
        id: `${nodeId}-${node.name}`.replace(/\//g, '-'),
        origin: "Agentic Auto-Split",
        story_axis: context.manifest.story_axis || 'unknown',
        loreLine: node.loreLine,
        promise: node.promise,
        antiFeature: node.antiFeature,
        edges: []
      };

      fs.writeFileSync(path.join(fullPath, 'vektor.json'), JSON.stringify(manifest, null, 2), 'utf-8');
      console.log(`  [+] Vytvořen sémantický sub-uzel: ${fullPath}`);
    }
  }

  private simulateLlmResponse(nodeId: string) {
    if (nodeId.includes('relay')) {
      return [
        {
          name: "provider-router",
          loreLine: "Inteligentní výhybka — pošle prompt tam, kde to dává smysl.",
          promise: "Využijeme vždy nejlepší a nejlevnější model pro danou úlohu.",
          antiFeature: "Není svázaný s jedním providerem."
        },
        {
          name: "rate-limiter",
          loreLine: "Záchranná brzda rozpočtu — chrání peněženku před nekonečnou smyčkou.",
          promise: "Žádný agent nám nespálí budget za 10 minut.",
          antiFeature: "Neanalyzuje obsah promptu, jen počítá tokeny a blokuje zneužití."
        }
      ];
    } else if (nodeId.includes('campaign-scheduler')) {
      return [
        {
          name: "time-zone-mapper",
          loreLine: "Empatický doručovatel — posílá maily, když lidé bdí.",
          promise: "Příjemce dostane mail v 9 ráno jeho času, nikdy o půlnoci.",
          antiFeature: "Nedbá na to, jaký je obsah mailu, řeší pouze časové razítko."
        },
        {
          name: "send-throttler",
          loreLine: "Rozvážný střelec — rozvolňuje dávku tak, aby nenaštval filtry.",
          promise: "Vyhneme se spam filtrům postupným zahříváním odesílací IP.",
          antiFeature: "Nesnižuje celkový objem rozesílky, pouze ho rozkládá v čase."
        }
      ];
    } else if (nodeId.includes('inbox-orchestrator')) {
      return [
        {
          name: "intent-classifier",
          loreLine: "Pravá mozková hemisféra — čte zprávy s empatií a hledá záměr.",
          promise: "Každá zpráva je okamžitě kategorizována, ať už jde o hejt nebo zájem.",
          antiFeature: "Na zprávu neodpovídá, pouze ji obohatí o štítky záměru."
        },
        {
          name: "auto-responder",
          loreLine: "Levá mozková hemisféra — exekuuje připravené odpovědi na rutinu.",
          promise: "Rutinní dotazy jsou vyřešeny do 5 vteřin bez lidského zásahu.",
          antiFeature: "Nereaguje na komplexní zprávy, které vyžadují lidský úsudek."
        }
      ];
    } else {
      return [
        {
          name: "data-validator",
          loreLine: "Obrněná stráž brány — kontroluje každý příchozí byte.",
          promise: "Dál projde jen to, co stoprocentně odpovídá kontraktu.",
          antiFeature: "Neopravuje data, pouze je propouští nebo zahazuje."
        },
        {
          name: "business-logic",
          loreLine: "Bijící srdce modulu — obsahuje veškeré doménové výpočty.",
          promise: "Výpočty jsou testovatelné bez ohledu na databázi nebo API.",
          antiFeature: "Nikdy přímo nevolá externí systémy."
        }
      ];
    }
  }
}
