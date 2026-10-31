// The receipt check result. A green badge only ever means the signature really verified; every other state says so.
import type { VerifyResult } from '../lib/types';

export const VERIFIER_DOWNLOAD = '/api/export/receipts.jsonl';

export function VerifyBadge({ status, reasonText, compact }: { status: string; reasonText?: string | null; compact?: boolean }) {
  if (status === 'verified') return <span className="badge badge--ok">Receipt verified</span>;
  if (status === 'failed')
    return (
      <span className="badge badge--bad" title="The receipt does not check out. Treat this cost as unconfirmed.">
        {reasonText ? `Failed: ${reasonText}` : 'Verification failed'}
      </span>
    );
  if (status === 'unverified')
    return (
      <span className="badge badge--sim" title={reasonText ?? 'We could not check this here. Export the receipts and verify offline.'}>
        Not verified here. Verify offline{compact ? '' : <> (<a href="#verify-offline" onClick={(e) => e.stopPropagation()}>how</a>)</>}
      </span>
    );
  return <span className="badge badge--bad">No receipt</span>;
}

export const verifyLabel = (v: Pick<VerifyResult, 'verify_status' | 'reason_text'>) => (v.verify_status === 'verified' ? 'Receipt verified' : v.reason_text ?? v.verify_status);
