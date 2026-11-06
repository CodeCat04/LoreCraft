/** The infobox as a reader sees it. */

import { useEffect, useState, type ReactNode } from 'react';

import { hasVisibleInfobox, splitTitles, visibleFields } from './infobox';
import { WikiLink } from './links';
import { useInfoboxFacts } from '../facts';
import { assetUrl } from '../lib/assets';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import type { Infobox, InfoboxField } from '../lib/types';

/** A displayable address for a project image, or null while it loads or if it fails. */
export function useAssetUrl(id: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!id) return;
    let cancelled = false;
    assetUrl(id).then(
      (next) => {
        if (!cancelled) setUrl(next);
      },
      () => {
        if (!cancelled) setUrl(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  return url;
}

function FieldValue({ field }: { field: InfoboxField }) {
  if (field.kind === 'page') return <WikiLink target={field.value.trim()} />;
  if (field.kind === 'pages') {
    const titles = splitTitles(field.value);
    return (
      <>
        {titles.map((title, index) => (
          <span key={title}>
            <WikiLink target={title} />
            {index < titles.length - 1 && ', '}
          </span>
        ))}
      </>
    );
  }
  if (field.kind === 'longtext') return <span className="wiki-infobox-long">{field.value}</span>;
  return <>{field.value}</>;
}

export function InfoboxView(props: { title: string; infobox: Infobox; extraRow?: ReactNode }) {
  const { title, infobox, extraRow } = props;
  useLocale();
  const image = useAssetUrl(infobox.imageAssetId);
  const facts = useInfoboxFacts(infobox);
  if (!hasVisibleInfobox(infobox)) return null;
  return (
    <aside className="wiki-infobox" aria-label={t('Infobox')}>
      <div className="wiki-infobox-title">{title}</div>
      {infobox.imageAssetId && (
        <figure className="wiki-infobox-figure">
          {image && <img src={image} alt={infobox.caption || title} />}
          {infobox.caption && <figcaption>{infobox.caption}</figcaption>}
        </figure>
      )}
      {facts.control}
      <table className="wiki-infobox-table">
        <tbody>
          {visibleFields(facts.shown).map((field, index) => (
            <tr key={`${field.key}:${index}`} data-field={field.key}>
              <th scope="row">{field.label}</th>
              <td>
                {field.value.trim() !== '' && <FieldValue field={field} />}
                {facts.history(field.key, (value) => <FieldValue field={{ ...field, value }} />)}
              </td>
            </tr>
          ))}
          {extraRow}
        </tbody>
      </table>
    </aside>
  );
}
