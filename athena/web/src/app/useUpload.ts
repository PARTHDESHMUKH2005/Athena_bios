import { useCallback, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { errorCopy } from '../lib/format';
import { LIMITS } from '../lib/limits';

export interface UploadState {
  name: string;
  step: 'reading' | 'sending' | 'indexing';
  done: number;
  total: number;
}

export type Pack = 'general' | 'invoice';

/**
 * The client half of ingest (athena.md 2.4): read the text in the browser, then create the document, store the
 * original file, send the pages in batches of 25, and finalize. Returns a plain-language result for the toast.
 */
export function useUpload(onFinished: () => Promise<void> | void) {
  const [state, setState] = useState<UploadState | null>(null);

  const run = useCallback(
    async (file: File, pack: Pack): Promise<{ ok: boolean; message: string }> => {
      if (state) return { ok: false, message: 'Another upload is still running.' };
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return { ok: false, message: 'Please choose a PDF file.' };
      if (file.size > LIMITS.maxBytes) return { ok: false, message: 'That file is too large. Files can be up to 25 MB and 150 pages.' };
      let pdf: typeof import('../lib/pdf') | null = null;
      try {
        setState({ name: file.name, step: 'reading', done: 0, total: 1 });
        pdf = await import('../lib/pdf'); // loaded on first upload, not with the site
        const pages = await pdf.extractPdf(await file.arrayBuffer(), (done, total) => setState({ name: file.name, step: 'reading', done, total }));
        if (!pages.some((p) => p.trim().length >= 25)) {
          return { ok: false, message: 'No readable text found. This looks like a scanned PDF, and reading scanned pages is not supported yet.' };
        }
        setState({ name: file.name, step: 'sending', done: 0, total: pages.length });
        const { document_id: id } = await api.createDoc({ filename: file.name, size_bytes: file.size, page_count: pages.length, pack });
        await api.uploadFile(id, file);
        for (let i = 0; i < pages.length; i += LIMITS.batch) {
          const batch = pages.slice(i, i + LIMITS.batch).map((text, j) => ({ page_no: i + j + 1, text }));
          await api.putPages(id, batch);
          setState({ name: file.name, step: 'sending', done: Math.min(pages.length, i + LIMITS.batch), total: pages.length });
        }
        setState({ name: file.name, step: 'indexing', done: pages.length, total: pages.length });
        const fin = await api.finalize(id);
        await onFinished();
        const scanned = fin.status === 'partial';
        return {
          ok: true,
          message: scanned
            ? `Ready, but some pages look scanned and were not read. Answers will not cover them. ${pages.length} pages, ${fin.sections} sections.`
            : `Ready to ask. ${pages.length} page${pages.length === 1 ? '' : 's'}, ${fin.sections} section${fin.sections === 1 ? '' : 's'}.`,
        };
      } catch (e) {
        if (pdf && e instanceof pdf.PdfError) return { ok: false, message: e.message };
        if (e instanceof ApiError) {
          const c = errorCopy(e.code);
          return { ok: false, message: `${c.title}. ${e.code === 'validation_failed' || e.code === 'rate_limited' ? e.message : c.text}` };
        }
        return { ok: false, message: "We couldn't finish indexing this file. Try uploading it again." };
      } finally {
        setState(null);
      }
    },
    [state, onFinished],
  );

  /** Fetch a bundled sample PDF and run it through the same path as an upload. */
  const runSample = useCallback(
    async (kind: 'agreement' | 'invoice') => {
      const file = kind === 'agreement' ? 'sample-agreement.pdf' : 'sample-invoice.pdf';
      try {
        const r = await fetch(`/samples/${file}`);
        if (!r.ok) throw new Error('missing');
        const blob = await r.blob();
        return run(new File([blob], file, { type: 'application/pdf' }), kind === 'invoice' ? 'invoice' : 'general');
      } catch {
        return { ok: false, message: "Couldn't load the sample document." };
      }
    },
    [run],
  );

  return { state, run, runSample };
}
