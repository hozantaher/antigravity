import { randomFrom, USER_AGENTS } from '../../../shared/fetch.js';

const BASE_URL = 'https://rozhodnuti.justice.cz/api';

export const fetchJson = async <T>(path: string): Promise<T> => {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': randomFrom(USER_AGENTS),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json() as Promise<T>;
};

// GET /api/opendata → [{rok, pocet, odkaz}]
export interface YearEntry {
  rok: number;
  pocet: number;
  odkaz: string;
}

// GET /api/opendata/{year}/{month}/{day}?page=N
export interface DayPageResponse {
  items: DayPageItem[];
  numberOfItems: number;
  pageSize: number;
  pageNumber: number;
  totalPages: number;
  totalElements: number;
}

export interface DayPageItem {
  jednaciCislo: string;
  soud: string;
  autor: string;
  ecli: string;
  predmetRizeni: string;
  datumVydani: string;
  datumZverejneni: string;
  klicovaSlova: string[];
  zminenaUstanoveni: string[];
  odkaz: string;
}

// GET /api/finaldoc/{uuid}
export interface DetailResponse {
  uuid: string;
  metadata: DetailMetadata;
  verdictText?: string;
  justificationText?: string;
  header?: unknown[];
  verdict?: unknown[];
  justification?: unknown[];
  information?: unknown[];
  [key: string]: unknown;
}

export interface DetailMetadata {
  type?: string;
  ecli?: string;
  publishedAt?: string;
  decisionAt?: string;
  caseNumber?: {
    senate?: number;
    registry?: string;
    index?: number;
    year?: number;
    pageNumber?: number;
  };
  solver?: {
    titlesBefore?: string;
    firstName?: string;
    lastName?: string;
    titlesAfter?: string;
    function?: string;
  };
  courtCode?: string;
  caseResultType?: string[];
  caseSubject?: string;
  specialType?: string[];
  regulations?: unknown[];
  flags?: string[];
  affectedDocs?: unknown[];
}

export const fetchYears = (): Promise<YearEntry[]> => fetchJson('/opendata');

export const fetchDayPage = (year: number, month: number, day: number, page: number): Promise<DayPageResponse> =>
  fetchJson(`/opendata/${year}/${month}/${day}?page=${page}`);

export const fetchDetail = (uuid: string): Promise<DetailResponse> => fetchJson(`/finaldoc/${uuid}`);
