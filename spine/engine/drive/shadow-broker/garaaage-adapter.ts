import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// @vektor-link: shadow-broker

// Pokus o načtení lokálního .env
const envPath = existsSync(resolve(process.cwd(), '.env')) ? resolve(process.cwd(), '.env') : null;
if (envPath) {
  dotenv.config({ path: envPath });
}

// Mapování jen těch sloupců, které ShadowBroker potřebuje
interface ItemsTable {
  id: string;
  internal_id: string | null;
  title: string;
  image: string;
  images: string[];
  description: Record<string, string> | null;
  price_from_amount: string | number | null;
  price_from_currency: string | null;
  category_id: string;
  user_id: string;
  type: 'auction' | 'ad';
  hidden: boolean;
  sold: boolean;
  closed: boolean;
  created: Date | string;
  vin: string | null;
  first_registration_date: string | null;
}

interface UsersTable {
  id: string;
  email: string;
  full_name: string;
  auth_type: string;
  created: Date | string;
  roles: string[];
}

interface GaraaageDatabase {
  items: ItemsTable;
  users: UsersTable;
}

export class GaraaageAdapter {
  private db: Kysely<GaraaageDatabase> | null = null;

  constructor() {
    const connectionString = process.env.GARAAAGE_POSTGRES_URL;
    if (!connectionString) {
      console.warn('[GaraaageAdapter] ⚠️ VAROVÁNÍ: Chybí GARAAAGE_POSTGRES_URL. Garaaage adaptér poběží v Dry-Run režimu.');
      return;
    }

    const pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    });

    this.db = new Kysely<GaraaageDatabase>({
      dialect: new PostgresDialect({ pool }),
    });
    
    console.log('[GaraaageAdapter] ✅ Živě připojen k Garaaage Postgres Databázi.');
  }

  /**
   * Založí stínový inzerát přímo do produkce.
   * "Zero-Downtime Shadow Integration" garantuje, že inzerát je skrytý (hidden: true).
   */
  async createShadowDraft(params: {
    id: string;
    userId: string;
    title: string;
    priceAmount: number;
    currency: string;
    images: string[];
    description: Record<string, string>;
    vin?: string;
    firstRegistrationDate?: string;
  }) {
    if (!this.db) {
      console.log(`[GaraaageAdapter] DRY RUN: Vytvářím shadow draft ${params.id} pro ${params.title}`);
      return;
    }

    try {
      await this.db
        .insertInto('items')
        .values({
          id: params.id,
          title: params.title,
          image: params.images[0] || '',
          images: JSON.stringify(params.images) as any, // jsonb array
          description: JSON.stringify(params.description) as any, // jsonb
          price_from_amount: params.priceAmount,
          price_from_currency: params.currency,
          category_id: 'car', // Skutečné UUID/string kategorie (dle fixtures: 'car', 'moto', 't', ...)
          user_id: params.userId,
          type: 'ad',          // Bude inzerát, prozatím
          hidden: true,        // KRYCÍ OPERACE: Uživatelé nesmí vidět stínový draft!
          sold: false,
          closed: false,
          vin: params.vin || null,
          first_registration_date: params.firstRegistrationDate || null,
          created: new Date().toISOString(),
        })
        .execute();
      
      console.log(`[GaraaageAdapter] 🥷 Stínový inzerát ${params.id} úspěšně vložen do Garaaage DB.`);
    } catch (err) {
      console.error(`[GaraaageAdapter] ❌ Selhalo vložení stínového inzerátu:`, err);
      throw err;
    }
  }

  /**
   * Zkontroluje nebo vytvoří systémového uživatele pro Shadow Broker, 
   * pod kterým se budou ukládat zakoupená auta z arbitráže.
   */
  async ensureShadowSystemUser(): Promise<string> {
    const shadowUserId = 'system_shadow_broker';
    
    if (!this.db) {
      return shadowUserId;
    }

    const existing = await this.db
      .selectFrom('users')
      .where('id', '=', shadowUserId)
      .select('id')
      .executeTakeFirst();

    if (existing) {
      return existing.id;
    }

    await this.db
      .insertInto('users')
      .values({
        id: shadowUserId,
        email: 'shadowbroker@antigravity.internal',
        full_name: 'Antigravity Shadow Broker',
        auth_type: 'email',
        roles: JSON.stringify(['system']) as any,
        created: new Date().toISOString()
      })
      .execute();
      
    return shadowUserId;
  }
}
