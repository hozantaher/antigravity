import type { ScraperConfigBase } from '../../lib/types.js';

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
  autoline_id?: string;

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
  aggregate_rating?: number;
  review_count?: number;

  // JSON-LD ImageObject
  seller_name?: string;
  content_location?: string;
  date_published?: string;

  // JSON-LD BreadcrumbList
  category_path?: string;
  category?: string;

  // Images
  image_urls?: string;
  image_count?: number;

  // HTML specs
  vehicle_type?: string;
  first_registration?: string;
  mileage?: string;
  mileage_km?: number;
  volume?: string;
  payload?: string;
  gross_weight?: string;
  location_country?: string;
  location_city?: string;
  dealer_id?: string;
  listing_date?: string;

  // Engine / drivetrain
  engine_power?: string;
  fuel_type?: string;
  engine_displacement?: string;
  fuel_tank?: string;
  transmission?: string;
  axle_count?: string;
  axle_configuration?: string;
  wheelbase?: string;

  // Condition / other
  condition?: string;
  vin?: string;
  color?: string;
  body_dimensions?: string;
  air_conditioning?: string;

  // Features as JSON array
  features?: string;

  // Raw data
  raw_specs_json?: string;
  raw_jsonld?: string;
}
