import type { ScraperConfigBase } from '../shared/types.js';

export type VehicleCategory = 'Car' | 'Motorbike' | 'Truck' | 'MotorHome';

export interface ScraperConfig extends ScraperConfigBase {
  phase: 'all' | 'search' | 'detail';
  categories: VehicleCategory[];
  headless: boolean;
}

export interface UrlRow {
  id: number;
  url: string;
  mobile_id: string;
  category: VehicleCategory | null;
  status: 'pending' | 'scraped' | 'failed' | 'gone';
  attempts: number;
  last_attempt_at: string | null;
  error_message: string | null;
}

export interface SearchProgressRow {
  id: number;
  category: VehicleCategory;
  total_results: number | null;
  last_page_scraped: number;
  total_pages: number | null;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface SearchSegmentRow {
  id: number;
  category: string;
  price_from: number;
  price_to: number;
  total_results: number | null;
  last_page_scraped: number;
  total_pages: number | null;
  status: 'pending' | 'in_progress' | 'completed' | 'split';
}

export interface ListingData {
  url: string;
  mobile_id: string;
  category?: string;

  // Title
  title?: string;
  subtitle?: string;

  // Price
  price_eur?: number;
  price_eur_original?: number;
  price_czk?: number;
  price_evaluation?: string;

  // Key features
  mileage?: string;
  mileage_km?: number;
  power?: string;
  fuel?: string;
  transmission?: string;
  first_registration?: string;
  num_owners?: number;

  // Technical data
  damage_condition?: string;
  body_category?: string;
  model_range?: string;
  trim_line?: string;
  cubic_capacity?: string;
  engine_type?: string;
  energy_consumption?: string;
  co2_emissions?: string;
  co2_class?: string;
  fuel_consumption?: string;
  num_seats?: number;
  door_count?: string;
  climatisation?: string;
  park_assists?: string;
  airbag?: string;
  manufacturer_color?: string;
  color?: string;
  interior?: string;

  // Features
  features?: string;

  // Description
  description?: string;

  // Seller
  seller_name?: string;
  seller_address1?: string;
  seller_address2?: string;
  seller_rating?: string;
  seller_rating_count?: string;
  seller_id?: string;

  // Images
  image_urls?: string;
  image_count?: number;

  // Raw data
  raw_technical_data?: string;
  raw_key_features?: string;
}
