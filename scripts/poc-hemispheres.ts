/**
 * PROOF OF CONCEPT: Hemispheric Symphony
 * Tento skript simuluje 3 nejrelevantnější plány pro spojení hemisfér:
 * 1. Event Bus (Plan 6)
 * 2. Blackboard / Shared State (Plan 2)
 * 3. Central Orchestrator (Plan 5)
 */

import { EventEmitter } from 'events';

console.log("=== START: HEMISPHERIC SYMPHONY PoC ===\n");

// --- Mock Data ---
const marketData = [
  { id: 1, type: 'car', price: 50000, realValue: 80000 },
  { id: 2, type: 'car', price: 120000, realValue: 110000 },
  { id: 3, type: 'fleet', price: 400000, realValue: 650000 }
];

// --- PLAN 6: Event Bus ---
console.log("--- POC 1: Event Bus ---");
const bus = new EventEmitter();

// Pravá hemisféra (Miner)
bus.on('market_tick', (data) => {
  const opportunities = data.filter((d: any) => d.realValue > d.price * 1.2);
  if (opportunities.length > 0) {
    bus.emit('opportunity_found', opportunities);
  }
});

// Levá hemisféra (Broker)
bus.on('opportunity_found', (ops) => {
  ops.forEach((op: any) => {
    console.log(`[Left Brain/EventBus] Executing Shadow Draft for asset ${op.id}. Expected profit: ${op.realValue - op.price}`);
  });
});

bus.emit('market_tick', marketData);


// --- PLAN 2: Blackboard (Shared State) ---
console.log("\n--- POC 2: Blackboard ---");
class Blackboard {
  public opportunities: any[] = [];
}
const board = new Blackboard();

// Pravá hemisféra
const rightBrainEvaluate = (data: any[]) => {
  const ops = data.filter((d: any) => d.realValue > d.price * 1.2);
  board.opportunities.push(...ops);
};

// Levá hemisféra
const leftBrainExecute = () => {
  while(board.opportunities.length > 0) {
    const op = board.opportunities.pop();
    console.log(`[Left Brain/Blackboard] Executing Shadow Draft for asset ${op.id}.`);
  }
};

rightBrainEvaluate(marketData);
leftBrainExecute();


// --- PLAN 5: Central Orchestrator ---
console.log("\n--- POC 3: Central Orchestrator ---");

const Orchestrator = {
  runSymphony: (data: any[]) => {
    // Krok 1: Zeptej se pravé hemisféry (Cognitive)
    const rightBrainResponse = data.filter((d: any) => d.realValue > d.price * 1.2);
    
    // Krok 2: Předej levé hemisféře (Execution)
    rightBrainResponse.forEach((op: any) => {
      console.log(`[Left Brain/Orchestrator] Executing Shadow Draft for asset ${op.id}.`);
    });
  }
};

Orchestrator.runSymphony(marketData);

console.log("\n=== END: PoC ===");
