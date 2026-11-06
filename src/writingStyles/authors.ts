/** Every author in the library, gathered from one data file per genre. */

import { CRIME } from './authors/crime';
import { FANTASY } from './authors/fantasy';
import { HARD_SF } from './authors/hardSf';
import { HORROR } from './authors/horror';
import { LITERARY } from './authors/literary';
import { LITERARY_CLASSICS } from './authors/literaryClassics';
import { ROMANCE_HISTORICAL } from './authors/romanceHistorical';
import { SPACE_OPERA } from './authors/spaceOpera';
import { THRILLERS } from './authors/thrillers';
import { YOUNG_ADULT } from './authors/youngAdult';
import { TECHNIQUE_DATA } from './techniques';
import type { AuthorStyle, TechniqueStyle } from './types';

export const AUTHORS: AuthorStyle[] = [
  ...HARD_SF,
  ...SPACE_OPERA,
  ...THRILLERS,
  ...FANTASY,
  ...YOUNG_ADULT,
  ...HORROR,
  ...CRIME,
  ...LITERARY,
  ...LITERARY_CLASSICS,
  ...ROMANCE_HISTORICAL,
].map((author) => ({ ...author, kind: 'author' }));

export const TECHNIQUES: TechniqueStyle[] = TECHNIQUE_DATA.map((technique) => ({
  ...technique,
  kind: 'technique',
}));
