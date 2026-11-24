/** Helpers for Uber's newer, HTML-only email receipts. */
export function receiptField(html: string, testId: string): string | null {
  const escaped = testId.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = new RegExp(`<([a-z][\\w-]*)\\b(?=[^>]*\\bdata-testid=["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  const match = tag.exec(html);
  if (!match) {return null;}
  return match[2]
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/&nbsp;|&#160;/gi, ' ')
    .replaceAll(/&amp;/gi, '&')
    .replaceAll(/&lt;/gi, '<')
    .replaceAll(/&gt;/gi, '>')
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&#39;/gi, "'")
    .replaceAll(/\s+/g, ' ')
    .trim();
}

export function receiptTotal(html: string): number | null {
  const text = receiptField(html, 'total_fare_amount');
  const match = text?.match(/\$\s*([\d,]+\.\d{2})/);
  return match ? Math.round(Number(match[1].replaceAll(',', '')) * 100) : null;
}

export function receiptDate(html: string): string | null {
  const date = receiptField(html, 'header_date');
  if (!date) {return null;}
  const match = date.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match) {return null;}
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.indexOf(match[1].toLowerCase());
  if (month < 0) {return null;}
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}
