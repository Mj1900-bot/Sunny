/** Relative label for the next calendar event (minutes / hours from now). */
export function nextEventStartsIn(startIso: string): string | null {
  const t = new Date(startIso).getTime();
  if (Number.isNaN(t)) return null;
  const diffMs = t - Date.now();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < -7 * 24 * 60) return null;
  if (diffMs < 0) {
    const agoMin = Math.max(1, Math.ceil(-diffMs / 60_000));
    return agoMin >= 60
      ? `${Math.floor(agoMin / 60)}h ago`
      : `${agoMin}m ago`;
  }
  if (diffMin < 1) return 'soon';
  if (diffMin < 60) return `in ${diffMin}m`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
}
