import { z } from 'zod';

export type PackId = 'general' | 'invoice';
export const PACK_IDS: PackId[] = ['general', 'invoice'];

export const INVOICE_INSTRUCTIONS = `Extract the invoice as ONE JSON object and nothing else (no prose, no code fences) with exactly these keys:
vendor, invoice_number, invoice_date, due_date, currency, line_items (array of {description, quantity, unit_price, amount}), subtotal, tax, total.
Use null for anything not present. Numbers must be JSON numbers, not strings. Dates as written in the document.`;

export const InvoiceSchema = z.object({
  vendor: z.string().nullable(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable(),
  due_date: z.string().nullable(),
  currency: z.string().nullable(),
  line_items: z.array(
    z.object({
      description: z.string(),
      quantity: z.number().nullable().optional(),
      unit_price: z.number().nullable().optional(),
      amount: z.number(),
    }),
  ),
  subtotal: z.number().nullable().optional(),
  tax: z.number().nullable().optional(),
  total: z.number().nullable(),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

/** Model output may wrap JSON in a code fence; accept that, nothing looser. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(t);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Code check, no model: do the line items add up to the total? */
export function checkInvoiceTotal(inv: Invoice): { ok: boolean; message: string } {
  const lines = r2(inv.line_items.reduce((s, l) => s + l.amount, 0));
  const tax = inv.tax ?? 0;
  if (inv.total == null) return { ok: false, message: 'No total found on the invoice.' };
  const base = inv.subtotal != null ? inv.subtotal : lines;
  if (inv.subtotal != null && Math.abs(lines - inv.subtotal) > 0.01) {
    return { ok: false, message: `Line items add up to ${lines}, but the subtotal is ${inv.subtotal}.` };
  }
  const expected = r2(base + tax);
  if (Math.abs(expected - inv.total) > 0.01) {
    return { ok: false, message: `Expected a total of ${expected} (items${tax ? ' plus tax' : ''}), but the invoice says ${inv.total}.` };
  }
  return { ok: true, message: `Line items${tax ? ' plus tax' : ''} add up to the total (${inv.total}).` };
}
