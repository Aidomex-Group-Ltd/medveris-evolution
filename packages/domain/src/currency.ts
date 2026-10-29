import { DomainError } from "./errors.js";

/**
 * Currencies a facility can price and bill in, with the number of decimal places used for amounts.
 * UGX, RWF and BIF have no minor unit in everyday use.
 */
export const CURRENCIES = {
  UGX: { name: "Uganda shilling", minorDigits: 0 },
  KES: { name: "Kenya shilling", minorDigits: 2 },
  TZS: { name: "Tanzania shilling", minorDigits: 2 },
  RWF: { name: "Rwanda franc", minorDigits: 0 },
  BIF: { name: "Burundi franc", minorDigits: 0 },
  SSP: { name: "South Sudanese pound", minorDigits: 2 },
  CDF: { name: "Congolese franc", minorDigits: 2 },
  ETB: { name: "Ethiopian birr", minorDigits: 2 },
  NGN: { name: "Nigerian naira", minorDigits: 2 },
  GHS: { name: "Ghanaian cedi", minorDigits: 2 },
  ZAR: { name: "South African rand", minorDigits: 2 },
  ZMW: { name: "Zambian kwacha", minorDigits: 2 },
  MWK: { name: "Malawian kwacha", minorDigits: 2 },
  USD: { name: "US dollar", minorDigits: 2 },
  EUR: { name: "Euro", minorDigits: 2 },
  GBP: { name: "Pound sterling", minorDigits: 2 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;
export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];
/** Currencies a facility price list may use. */
export const FACILITY_PRICE_CURRENCIES = CURRENCY_CODES as unknown as readonly [CurrencyCode, ...CurrencyCode[]];

/** The legal tender of each country a facility can register in, keyed by the country name stored on the workspace. */
const COUNTRY_CURRENCY: Readonly<Record<string, CurrencyCode>> = Object.freeze({
  uganda: "UGX",
  kenya: "KES",
  tanzania: "TZS",
  "united republic of tanzania": "TZS",
  rwanda: "RWF",
  burundi: "BIF",
  "south sudan": "SSP",
  "democratic republic of the congo": "CDF",
  "dr congo": "CDF",
  ethiopia: "ETB",
  nigeria: "NGN",
  ghana: "GHS",
  "south africa": "ZAR",
  zambia: "ZMW",
  malawi: "MWK",
  "united states": "USD",
  "united states of america": "USD",
  "united kingdom": "GBP",
});

/** The facility's local currency from its country, or null when the country is not mapped. */
export function localCurrencyForCountry(country: string | null | undefined): CurrencyCode | null {
  if (!country) return null;
  return COUNTRY_CURRENCY[country.trim().toLowerCase()] ?? null;
}

export function isCurrencyCode(code: string): code is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

export function currencyMinorDigits(code: string): number {
  return isCurrencyCode(code) ? CURRENCIES[code].minorDigits : 2;
}

/** Whether `amount` has no more decimal places than the currency allows. */
export function fitsCurrencyPrecision(amount: number, code: string): boolean {
  const scale = 10 ** currencyMinorDigits(code);
  return Math.abs(Math.round(amount * scale) - amount * scale) < 1e-6;
}

/** Rounds half away from zero to the currency's decimal places. */
export function roundToCurrency(amount: number, code: string): number {
  if (!Number.isFinite(amount)) throw new DomainError("Amount is not a finite number");
  const scale = 10 ** currencyMinorDigits(code);
  const rounded = Math.round(Math.abs(amount) * scale) / scale;
  return amount < 0 ? -rounded : rounded;
}

/** Mobile money through Yo! collects whole Uganda shillings only. */
export const YO_CURRENCIES: readonly CurrencyCode[] = ["UGX"];

export function yoSupports(currency: string, amount?: number): boolean {
  if (!YO_CURRENCIES.includes(currency as CurrencyCode)) return false;
  return amount === undefined || Number.isInteger(amount);
}
