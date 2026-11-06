/** How page types look across the Atlas. Color comes from tokens, shape keeps types apart without it. */

import { t } from '../../lib/i18n';

export type TypeShape = 'circle' | 'square' | 'diamond' | 'hexagon' | 'triangle' | 'pentagon';

export interface TypeStyle {
  label: string;
  /** A CSS token defined in src/styles/extras.css. */
  token: string;
  shape: TypeShape;
}

/** Labels are read each time, so they follow the interface language. */
const STYLES: Record<string, Omit<TypeStyle, 'label'> & { label: () => string }> = {
  character: { label: () => t('Characters'), token: '--atlas-character', shape: 'circle' },
  place: { label: () => t('Places'), token: '--atlas-place', shape: 'square' },
  faction: { label: () => t('Factions'), token: '--atlas-faction', shape: 'hexagon' },
  item: { label: () => t('Items'), token: '--atlas-item', shape: 'diamond' },
  event: { label: () => t('Events'), token: '--atlas-event', shape: 'triangle' },
  concept: { label: () => t('Concepts'), token: '--atlas-concept', shape: 'pentagon' },
  article: { label: () => t('Articles'), token: '--atlas-other', shape: 'circle' },
  home: { label: () => t('Main page'), token: '--atlas-home', shape: 'circle' },
};

export const ATLAS_TOKENS = [
  '--atlas-character',
  '--atlas-place',
  '--atlas-faction',
  '--atlas-item',
  '--atlas-event',
  '--atlas-concept',
  '--atlas-other',
  '--atlas-home',
] as const;

export function typeStyle(pageType: string): TypeStyle {
  if (Object.hasOwn(STYLES, pageType)) {
    const { label, token, shape } = STYLES[pageType];
    return { label: label(), token, shape };
  }
  const label = pageType ? pageType[0].toUpperCase() + pageType.slice(1) : t('Other');
  return { label, token: '--atlas-other', shape: 'circle' };
}

/** Points of a regular shape on a unit circle, starting from the top. */
export function shapePoints(shape: TypeShape): [number, number][] {
  const sides = { square: 4, diamond: 4, hexagon: 6, triangle: 3, pentagon: 5, circle: 0 }[shape];
  const turn = shape === 'square' ? Math.PI / 4 : 0;
  const points: [number, number][] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = turn - Math.PI / 2 + (i * 2 * Math.PI) / sides;
    points.push([Math.cos(angle), Math.sin(angle)]);
  }
  return points;
}

/** The same mark the graph draws, for legends and lists. */
export function TypeMark({ pageType }: { pageType: string }) {
  const { token, shape } = typeStyle(pageType);
  const fill = `var(${token})`;
  return (
    <svg className="type-mark" viewBox="-1.1 -1.1 2.2 2.2" aria-hidden="true">
      {shape === 'circle' ? (
        <circle r="0.9" fill={fill} />
      ) : (
        <polygon points={shapePoints(shape).map(([x, y]) => `${x},${y}`).join(' ')} fill={fill} />
      )}
    </svg>
  );
}
