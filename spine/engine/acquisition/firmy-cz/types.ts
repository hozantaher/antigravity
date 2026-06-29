import type { ScraperConfigBase } from '../shared/types.js';

export interface ScraperConfig extends ScraperConfigBase {
  phase: 'all' | 'sitemap' | 'detail';
}

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

export interface UrlRow {
  id: number;
  url: string;
  firmy_id: number | null;
  slug: string | null;
  url_type: 'detail' | 'unverified' | null;
  sitemap_file: string | null;
  status: 'pending' | 'scraped' | 'failed' | 'gone';
  attempts: number;
  last_attempt_at: string | null;
  error_message: string | null;
}

export interface BusinessData {
  url: string;
  firmy_id?: number;
  url_type?: string;

  // Core identity
  name?: string;
  description?: string;
  ico?: string;
  datova_schranka?: string;
  datum_zapisu?: string;
  pravni_forma?: string;
  velikost_firmy?: string;

  // Contact
  website?: string;
  telephone?: string;
  email?: string;

  // Location
  street_address?: string;
  address_locality?: string;
  postal_code?: string;
  address_country?: string;
  latitude?: number;
  longitude?: number;

  // Categories
  category_path?: string;
  categories_json?: string;

  // Opening hours
  opening_hours?: string;
  opening_hours_detail?: string;

  // Ratings
  rating_value?: number;
  rating_count?: number;

  // Media
  primary_image?: string;
  image_urls?: string;
  image_count?: number;

  // Features / Social
  filters_json?: string;
  same_as_json?: string;

  // Raw data
  raw_html?: string;
  raw_jsonld?: string;
}
