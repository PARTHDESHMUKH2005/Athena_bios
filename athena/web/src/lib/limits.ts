// Upload limits, kept separate from pdf.ts so the PDF library loads only when someone actually uploads.
export const LIMITS = { maxBytes: 25 * 1024 * 1024, maxPages: 150, batch: 25 };
