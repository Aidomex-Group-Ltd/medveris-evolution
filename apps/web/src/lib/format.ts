export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

export function formatMoney(value: number | string | null | undefined, currency = "UGX"): string {
  if (value == null) return "—";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function todayInput(): string {
  return new Date().toISOString().slice(0, 10);
}

export function futureIso(days = 1, minutes = 0): string {
  return new Date(Date.now() + days * 86_400_000 + minutes * 60_000).toISOString();
}
