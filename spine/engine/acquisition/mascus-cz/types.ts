import type { ScraperConfigBase } from '../shared/types.js';

export interface ScraperConfig extends ScraperConfigBase {
  phase: 'all' | 'sitemap' | 'detail';
}

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

export interface SitemapEntry {
  file: string;
  urls: SitemapUrl[];
}

export interface UrlRow {
  id: number;
  url: string;
  sitemap_file: string | null;
  lastmod: string | null;
  status: 'pending' | 'scraped' | 'failed' | 'gone';
  attempts: number;
  last_attempt_at: string | null;
  error_message: string | null;
}

export interface ListingData {
  url: string;
  mascus_id?: string;

  // JSON-LD Product
  name?: string;
  brand?: string;
  model?: string;
  sku?: string;
  description?: string;
  price?: number;
  price_currency?: string;
  item_condition?: string;
  availability?: string;

  // JSON-LD offers.seller
  seller_name?: string;

  // JSON-LD BreadcrumbList
  category_path?: string;
  category?: string;

  // Images (from HTML)
  image_urls?: string;
  image_count?: number;

  // HTML specs
  year_of_manufacture?: string;
  first_registration?: string;
  mileage?: string;
  mileage_km?: number;
  gross_weight?: string;
  location_country?: string;
  location_city?: string;

  // Engine / drivetrain
  engine_power?: string;
  engine_displacement?: string;
  transmission?: string;
  axle_configuration?: string;

  // Identification
  vin?: string;
  registration_number?: string;
  emission_class?: string;

  // Raw data
  raw_specs_json?: string;
  raw_jsonld?: string;
}
