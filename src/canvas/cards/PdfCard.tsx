/**
 * A PDF on a canvas: its first page, drawn by pdf.js, with "Open" for the whole file in the
 * system's viewer. See `src/media/pdf.ts` for why it is not shown in a frame.
 */

import { useEffect, useRef, useState } from 'react';

import type { AssetInfo } from '../../lib/assets';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { drawFirstPage, openInSystemViewer } from '../../media/pdf';
import { toast } from '../../shell/toasts';

export function PdfCard({ info }: { info: AssetInfo }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'failed' | { pages: number }>('loading');
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current!;
    drawFirstPage(info.id, canvas, canvas.parentElement?.clientWidth || 300).then(
      (preview) => !cancelled && setState(preview),
      () => !cancelled && setState('failed'),
    );
    return () => {
      cancelled = true;
    };
  }, [info.id]);
  const name = info.label || info.name;
  return (
    <div className="canvas-pdf" data-pdf-state={typeof state === 'string' ? state : 'ready'}>
      <div className="canvas-card-head">
        <span className="canvas-kind">{t('PDF')}</span>
        <span className="canvas-card-title truncate">{name}</span>
        <button
          type="button"
          className="btn btn-sm"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void openInSystemViewer(info.id).catch((e) => toast(errorMessage(e), 'error'))}
        >
          {t('Open')}
        </button>
      </div>
      <div className="canvas-pdf-page">
        <canvas ref={canvasRef} role="img" aria-label={t('First page of {name}', { name })} hidden={typeof state === 'string'} />
        {state === 'loading' && <div className="canvas-placeholder">{t('Loading…')}</div>}
        {state === 'failed' && <div className="canvas-placeholder">{t('The first page cannot be shown. Open it to read it.')}</div>}
      </div>
      {typeof state !== 'string' && (
        <span className="canvas-faint">{state.pages === 1 ? t('One page') : t('{count} pages', { count: state.pages })}</span>
      )}
    </div>
  );
}
