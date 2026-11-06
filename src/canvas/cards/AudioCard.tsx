/** A sound file on a canvas: its name and a player with the web view's own controls. */

import type { AssetInfo } from '../../lib/assets';
import { assetUrlNow } from '../../lib/assets';
import { t } from '../../lib/i18n';

export function AudioCard({ info }: { info: AssetInfo }) {
  const name = info.label || info.name;
  return (
    <div className="canvas-audio">
      <div className="canvas-card-head">
        <span className="canvas-kind">{t('Sound')}</span>
        <span className="canvas-card-title truncate">{name}</span>
      </div>
      <audio
        className="canvas-audio-player"
        src={assetUrlNow(info.id)}
        controls
        preload="metadata"
        aria-label={name}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {info.description && <span className="canvas-faint">{info.description}</span>}
    </div>
  );
}
