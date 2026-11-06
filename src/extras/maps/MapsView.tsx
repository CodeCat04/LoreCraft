import { useEffect, useState } from 'react';
import { create } from 'zustand';

import * as extras from '../api';
import { assetUrl } from '../../lib/assets';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { relativeTime } from '../../lib/text';
import { confirm, promptText } from '../../shell/dialogs';
import { toast } from '../../shell/toasts';
import { useDataVersion, useLoad } from '../../state/events';
import { useLocale } from '../../state/language';
import { useNav } from '../../state/nav';
import { MapCanvas } from './MapCanvas';
import { ImageRefused, pickAndStoreImage, titleFromFileName } from './upload';

/** A pin to bring into view the next time its map opens. */
const useMapFocus = create<{ pinId: string | null; set: (pinId: string | null) => void }>((set) => ({
  pinId: null,
  set: (pinId) => set({ pinId }),
}));

export async function newMapFromFile(): Promise<void> {
  try {
    const stored = await pickAndStoreImage();
    if (!stored) return;
    const map = await extras.mapCreate(titleFromFileName(stored.name), stored.assetId);
    useNav.getState().go({ view: 'maps', mapId: map.id });
  } catch (e) {
    if (e instanceof ImageRefused) toast(e.message, 'error');
    else toast(t('Could not add the map: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

async function renameMap(map: Pick<extras.MapInfo, 'id' | 'title'>) {
  const title = await promptText({
    title: t('Rename map'),
    label: t('Name'),
    initial: map.title,
    confirmLabel: t('Rename'),
    validate: (value) => (value.trim() ? null : t('A map needs a name.')),
  });
  if (title === null || title.trim() === map.title) return;
  try {
    await extras.mapRename(map.id, title);
  } catch (e) {
    toast(t('Could not rename the map: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

async function trashMap(map: Pick<extras.MapInfo, 'id' | 'title'>) {
  try {
    await extras.mapDelete(map.id);
    toast(t('{name} moved to the trash. Its pins are kept with it.', { name: map.title }));
    const { route, replace } = useNav.getState();
    if (route.view === 'maps' && route.mapId === map.id) replace({ view: 'maps' });
  } catch (e) {
    toast(t('Could not delete the map: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

async function restoreMap(map: extras.MapInfo) {
  try {
    await extras.mapRestore(map.id);
  } catch (e) {
    toast(t('Could not restore the map: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

async function purgeMap(map: extras.MapInfo) {
  const yes = await confirm({
    title: t('Delete {name} forever?', { name: map.title }),
    message: t('Its pins and its image go with it. This cannot be undone.'),
    confirmLabel: t('Delete forever'),
    danger: true,
  });
  if (!yes) return;
  try {
    await extras.mapPurge(map.id);
  } catch (e) {
    toast(t('Could not delete the map: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

function MapThumbnail({ assetId }: { assetId: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (assetId) {
      assetUrl(assetId).then(
        (found) => {
          if (live) setUrl(found);
        },
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [assetId]);
  return (
    <span className="map-thumb">
      {url ? <img src={url} alt="" decoding="async" draggable={false} /> : <span className="map-thumb-empty" />}
    </span>
  );
}

function pinCount(count: number): string {
  return count === 1 ? t('1 pin') : t('{count} pins', { count });
}

function openMapLabel(map: extras.MapInfo): string {
  return map.pinCount === 1
    ? t('Open {name}, 1 pin', { name: map.title })
    : t('Open {name}, {count} pins', { name: map.title, count: map.pinCount });
}

function trashedMapDetail(map: extras.MapInfo): string {
  if (!map.deletedAt) return pinCount(map.pinCount);
  const time = relativeTime(map.deletedAt);
  return map.pinCount === 1
    ? t('1 pin, deleted {time}', { time })
    : t('{count} pins, deleted {time}', { count: map.pinCount, time });
}

function MapsHome() {
  useLocale();
  const version = useDataVersion('extras');
  const go = useNav((s) => s.go);
  const { data: maps, error } = useLoad(() => extras.mapList(), [version]);
  const { data: trash } = useLoad(() => extras.mapList(true), [version]);

  if (error) {
    return (
      <div className="view-pad">
        <h1 className="view-title">{t('Maps')}</h1>
        <p className="error-detail">{t('Could not load your maps: {reason}', { reason: errorMessage(error) })}</p>
      </div>
    );
  }
  if (!maps) return <div className="atlas-view" />;

  return (
    <div className="atlas-view atlas-view-scroll" data-testid="maps-view">
      <header className="atlas-header">
        <h1 className="atlas-title">{t('Maps')}</h1>
        <span className="atlas-toolbar-spacer" />
        {maps.length > 0 && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void newMapFromFile()}>
            {t('New map')}
          </button>
        )}
      </header>

      {maps.length === 0 ? (
        <div className="empty-state atlas-empty">
          <h2 className="atlas-empty-title">{t('No maps yet')}</h2>
          <p>
            {t(
              'Bring in any picture of your world, then click on it to pin places, people and events. A pin can open the page it links to, and each page can list the maps it appears on.',
            )}
          </p>
          <div className="atlas-empty-actions">
            <button type="button" className="btn btn-primary" onClick={() => void newMapFromFile()}>
              {t('Choose an image')}
            </button>
          </div>
          <p className="muted small">{t('PNG, JPEG, GIF, WebP or AVIF, up to 64 MB. It is stored inside your project.')}</p>
        </div>
      ) : (
        <ul className="map-grid">
          {maps.map((map) => (
            <li key={map.id} className="map-card" data-map-card={map.title}>
              <button
                type="button"
                className="map-card-open"
                aria-label={openMapLabel(map)}
                onClick={() => go({ view: 'maps', mapId: map.id })}
              >
                <MapThumbnail assetId={map.assetId} />
                <span className="map-card-title truncate">{map.title}</span>
                <span className="map-card-meta">{pinCount(map.pinCount)}</span>
              </button>
              <div className="map-card-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={t('Rename {name}', { name: map.title })}
                  onClick={() => void renameMap(map)}
                >
                  {t('Rename')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={t('Delete {name}', { name: map.title })}
                  onClick={() => void trashMap(map)}
                >
                  {t('Delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {trash && trash.length > 0 && (
        <section className="map-trash" aria-labelledby="map-trash-title">
          <h2 id="map-trash-title" className="map-side-title">{t('Trash ({count})', { count: trash.length })}</h2>
          <ul className="map-trash-list">
            {trash.map((map) => (
              <li key={map.id} className="map-trash-row" data-trash-row={map.title}>
                <span className="map-trash-name truncate">{map.title}</span>
                <span className="muted small">{trashedMapDetail(map)}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={t('Restore {name}', { name: map.title })}
                  onClick={() => void restoreMap(map)}
                >
                  {t('Restore')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  aria-label={t('Delete {name} forever', { name: map.title })}
                  onClick={() => void purgeMap(map)}
                >
                  {t('Delete forever')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MapScreen({ mapId }: { mapId: string }) {
  useLocale();
  const version = useDataVersion('extras', 'pages');
  const go = useNav((s) => s.go);
  const focusPinId = useMapFocus((s) => s.pinId);
  const clearFocus = useMapFocus((s) => s.set);
  const { data: map, error, loading } = useLoad(() => extras.mapGet(mapId), [mapId, version]);

  if (error) {
    return (
      <div className="view-pad">
        <h1 className="view-title">{t('Maps')}</h1>
        <p className="muted">{t('That map could not be found. It may have been deleted.')}</p>
        <p style={{ marginTop: '0.75rem' }}>
          <button type="button" className="btn" onClick={() => go({ view: 'maps' })}>{t('All maps')}</button>
        </p>
      </div>
    );
  }
  if (!map) return <div className="atlas-view" aria-busy={loading} />;
  if (map.deletedAt) {
    return (
      <div className="view-pad">
        <h1 className="view-title">{map.title}</h1>
        <p className="muted">{t('This map is in the trash.')}</p>
        <p className="atlas-empty-actions" style={{ justifyContent: 'flex-start', marginTop: '0.75rem' }}>
          <button type="button" className="btn btn-primary" onClick={() => void restoreMap(map)}>{t('Restore')}</button>
          <button type="button" className="btn" onClick={() => go({ view: 'maps' })}>{t('All maps')}</button>
        </p>
      </div>
    );
  }

  return (
    <div className="atlas-view" data-testid="map-screen">
      <header className="atlas-header">
        <button type="button" className="btn btn-sm" onClick={() => go({ view: 'maps' })}>{t('All maps')}</button>
        <h1 className="atlas-title truncate">{map.title}</h1>
        <span className="atlas-toolbar-spacer" />
        <button type="button" className="btn btn-sm" onClick={() => void renameMap(map)}>{t('Rename')}</button>
        <button type="button" className="btn btn-sm" onClick={() => void trashMap(map)}>{t('Delete')}</button>
      </header>
      <MapCanvas map={map} focusPinId={focusPinId} onFocusHandled={() => clearFocus(null)} />
    </div>
  );
}

export function MapsView({ mapId }: { mapId?: string }) {
  return mapId ? <MapScreen key={mapId} mapId={mapId} /> : <MapsHome />;
}

/** The sidebar's list of maps. */
export function MapLinks({ activeId }: { activeId?: string }) {
  const version = useDataVersion('extras');
  const go = useNav((s) => s.go);
  const { data: maps } = useLoad(() => extras.mapList(), [version]);
  if (!maps || maps.length === 0) return null;
  return (
    <div className="atlas-map-links">
      {maps.map((map) => (
        <button
          key={map.id}
          type="button"
          className={`nav-link atlas-map-link${map.id === activeId ? ' is-active' : ''}`}
          aria-current={map.id === activeId ? 'page' : undefined}
          title={map.title}
          onClick={() => go({ view: 'maps', mapId: map.id })}
        >
          {map.title}
        </button>
      ))}
    </div>
  );
}

/**
 * Lists the maps a page has pins on. Renders nothing when there are none, so a page can
 * include it unconditionally.
 */
export function AppearsOnMaps({ pageId }: { pageId: string }) {
  useLocale();
  const version = useDataVersion('extras');
  const go = useNav((s) => s.go);
  const setFocus = useMapFocus((s) => s.set);
  const { data: places } = useLoad(() => extras.pageMaps(pageId), [pageId, version]);
  if (!places || places.length === 0) return null;
  return (
    <section className="appears-on-maps" aria-label={t('Appears on maps')}>
      <h2 className="page-extra-title">{t('Appears on maps')}</h2>
      <ul className="appears-on-maps-list">
        {places.map((place) => (
          <li key={place.pinId}>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setFocus(place.pinId);
                go({ view: 'maps', mapId: place.mapId });
              }}
            >
              {place.mapTitle}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
