import { invalid } from "./errors";

export const MAX_PRICE_DECIMALS = 8;

export interface PriceUnits {
  priceScale: number;
  tickSizeUnits: number;
}

export function priceUnitsFromTickSize(tickSize: number, field = "tickSize"): PriceUnits {
  const decimals = decimalPlaces(tickSize, field);
  if (decimals > MAX_PRICE_DECIMALS) {
    throw invalid(`${field} supports at most ${MAX_PRICE_DECIMALS} decimal places`, field);
  }
  const priceScale = 10 ** decimals;
  const tickSizeUnits = decimalToUnits(tickSize, priceScale, field);
  if (tickSizeUnits < 1) throw invalid(`${field} must be greater than zero`, field);
  return { priceScale, tickSizeUnits };
}

export function unitsForSnapshot(value: { priceScale?: number; tickSizeUnits?: number }): PriceUnits {
  const priceScale = value.priceScale ?? 1;
  const tickSizeUnits = value.tickSizeUnits ?? 1;
  if (!Number.isSafeInteger(priceScale) || priceScale < 1 || !Number.isSafeInteger(tickSizeUnits) || tickSizeUnits < 1) {
    throw invalid("persisted Financial price-unit metadata is invalid", "priceScale");
  }
  return { priceScale, tickSizeUnits };
}

export function decimalToUnits(value: number, scale: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw invalid(`${field} must be a finite non-negative number`, field);
  if (!Number.isSafeInteger(scale) || scale < 1 || !isPowerOfTen(scale)) throw invalid("price scale must be a power of ten", field);
  const { coefficient, exponent } = decimalParts(value, field);
  const scaleExponent = Math.round(Math.log10(scale));
  const shift = exponent + scaleExponent;
  let units: bigint;
  if (shift >= 0) {
    units = coefficient * (10n ** BigInt(shift));
  } else {
    const divisor = 10n ** BigInt(-shift);
    if (coefficient % divisor !== 0n) throw invalid(`${field} has more than ${scaleExponent} decimal places`, field);
    units = coefficient / divisor;
  }
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid(`${field} exceeds the safe Financial range`, field);
  return Number(units);
}

export function priceToUnits(value: number, units: PriceUnits, field: string): number {
  const result = decimalToUnits(value, units.priceScale, field);
  if (result < 1) throw invalid(`${field} must be greater than zero`, field);
  if (result % units.tickSizeUnits !== 0) {
    throw invalid(`${field} must be aligned to tickSize ${unitsToDecimal(units.tickSizeUnits, units.priceScale)}`, field);
  }
  return result;
}

export function cashToUnits(value: number, units: PriceUnits, field: string): number {
  return decimalToUnits(value, units.priceScale, field);
}

export function unitsToDecimal(value: number, scale: number): number {
  return value / scale;
}

export function decimalDelta(current: number, previous: number, scale: number): number {
  if (!Number.isSafeInteger(scale) || scale < 1 || !isPowerOfTen(scale)) {
    throw invalid("price scale must be a power of ten", "priceScale");
  }
  return unitsToDecimal(Math.round((current - previous) * scale), scale);
}

export function tickSizeFor(value: { priceScale?: number; tickSizeUnits?: number }): number {
  const units = unitsForSnapshot(value);
  return unitsToDecimal(units.tickSizeUnits, units.priceScale);
}

function decimalPlaces(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw invalid(`${field} must be a finite positive number`, field);
  const text = value.toString().toLowerCase();
  const [mantissa, exponentText] = text.split("e");
  const fractionLength = (mantissa!.split(".")[1] ?? "").length;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, fractionLength - exponent);
}

function decimalParts(value: number, field: string): { coefficient: bigint; exponent: number } {
  const text = value.toString().toLowerCase();
  const [mantissa, exponentText] = text.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = mantissa!.split(".");
  const digits = `${whole}${fraction}`;
  if (!/^\d+$/.test(digits) || !Number.isSafeInteger(exponent)) throw invalid(`${field} is not a supported decimal`, field);
  return { coefficient: BigInt(digits), exponent: exponent - fraction.length };
}

function isPowerOfTen(value: number): boolean {
  let cursor = value;
  while (cursor > 1 && cursor % 10 === 0) cursor /= 10;
  return cursor === 1;
}
