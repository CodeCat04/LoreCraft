/**
 * Rule checks: no AI, pure functions over the project. Each one speaks only when it is sure,
 * because a checker that cries wolf soon stops being read.
 */

import type { FindingDraft } from '../types';
import { similarNames, sharedAliases } from './names';
import { brokenFieldLinks, brokenLinks, missingReferences, retconnedLinks } from './references';
import { afterDeath, ageVsBorn, beforeBirth, bornAfterParentDied, dateOrder, parentOrder } from './timeline';
import type { World } from './world';

export { buildWorld } from './world';
export type { World, WorldInput, WorldNode, WorldPage } from './world';

const RULES: ((world: World) => FindingDraft[])[] = [
  similarNames,
  sharedAliases,
  dateOrder,
  parentOrder,
  bornAfterParentDied,
  afterDeath,
  beforeBirth,
  ageVsBorn,
  missingReferences,
  retconnedLinks,
  brokenFieldLinks,
  brokenLinks,
];

export function runRuleChecks(world: World): FindingDraft[] {
  return RULES.flatMap((rule) => rule(world));
}
