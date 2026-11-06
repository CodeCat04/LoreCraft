/** Typed wrappers over the `extras` RPC namespace. See src-tauri/src/rpc/extras.rs. */

import { rpc } from '../lib/rpc';
import type { InfoboxField, PageStatus } from '../lib/types';

// ---- Timeline --------------------------------------------------------------

export interface TimelinePageSource {
  id: string;
  title: string;
  pageType: string;
  status: PageStatus;
  /** Filled-in date fields, and any field that changes during the story. */
  fields: InfoboxField[];
}

export interface TimelineSceneSource {
  id: string;
  title: string;
  bookId: string;
  bookTitle: string;
  chapterTitle: string;
  storyDate: string;
  povPageId: string | null;
  /** Position in reading order, across all books. */
  order: number;
}

export interface TimelineSources {
  pages: TimelinePageSource[];
  scenes: TimelineSceneSource[];
  books: { id: string; title: string }[];
}

export interface TimelineScope {
  pageIds: string[];
  sceneIds: string[];
}

export const timelineData = () => rpc<TimelineSources>('extras.timelineData');
export const timelineScope = (scope: { pageId: string } | { bookId: string }) =>
  rpc<TimelineScope>('extras.timelineScope', scope);

// ---- Graph and relationships -----------------------------------------------

export interface GraphPage {
  id: string;
  title: string;
  pageType: string;
  status: PageStatus;
  isHome: boolean;
  categories: string[];
}

export interface Relationship {
  id: string;
  fromPageId: string;
  fromTitle: string;
  toPageId: string;
  toTitle: string;
  kind: string;
  /** How the kind reads from the other page, when known. The same word if it reads the same. */
  inverse: string | null;
  note: string;
  createdAt: string;
}

export interface RelationKind {
  kind: string;
  inverse: string;
  /** Fixed by the app, as opposed to declared in this project. */
  builtin: boolean;
}

export interface GraphData {
  nodes: GraphPage[];
  links: { from: string; to: string }[];
  relationships: Relationship[];
}

export interface RelationshipInput {
  fromPageId: string;
  toPageId: string;
  kind: string;
  note?: string;
}

export const graphData = () => rpc<GraphData>('extras.graphData');
export const relationshipList = (pageId?: string) =>
  rpc<Relationship[]>('extras.relationshipList', pageId ? { pageId } : {});
export const relationshipAdd = (input: RelationshipInput) =>
  rpc<Relationship>('extras.relationshipAdd', input);
export const relationshipUpdate = (id: string, patch: Partial<RelationshipInput>) =>
  rpc<Relationship>('extras.relationshipUpdate', { id, ...patch });
export const relationshipDelete = (id: string) => rpc<boolean>('extras.relationshipDelete', { id });
export const relationKinds = () => rpc<RelationKind[]>('extras.relationKinds');
/** Declares the other side of a custom kind. An empty `inverse` forgets it. */
export const relationKindSet = (kind: string, inverse: string) =>
  rpc<boolean>('extras.relationKindSet', { kind, inverse });

// ---- Families --------------------------------------------------------------

export interface FamilyPerson {
  /** For a name with no page yet, an id that only means something here. */
  id: string;
  title: string;
  pageType: string;
  status: string;
  born: string | null;
  died: string | null;
  /** Named in a family field, with no page yet. */
  missing: boolean;
  /** For a missing name: its page is in the trash, so restoring it brings the person back. */
  trashed?: boolean;
}

export interface FamilyData {
  people: FamilyPerson[];
  parents: { parent: string; child: string }[];
  spouses: { a: string; b: string }[];
}

export const familyData = () => rpc<FamilyData>('extras.familyData');

// ---- Maps ------------------------------------------------------------------

export interface MapInfo {
  id: string;
  title: string;
  assetId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  pinCount: number;
}

export interface MapPin {
  id: string;
  mapId: string;
  /** Still set while the page is in the trash, when `pageTitle` is null. */
  pageId: string | null;
  pageTitle: string | null;
  pageType: string | null;
  label: string;
  /** Fractions of the image's width and height, 0 to 1. */
  x: number;
  y: number;
  createdAt: string;
}

export interface MapWithPins extends MapInfo {
  pins: MapPin[];
}

export interface PinPlace {
  mapId: string;
  mapTitle: string;
  pinId: string;
  x: number;
  y: number;
}

export const mapList = (deleted = false) => rpc<MapInfo[]>('extras.mapList', { deleted });
export const mapGet = (id: string) => rpc<MapWithPins>('extras.mapGet', { id });
export const mapCreate = (title: string, assetId: string) =>
  rpc<MapInfo>('extras.mapCreate', { title, assetId });
export const mapRename = (id: string, title: string) =>
  rpc<boolean>('extras.mapRename', { id, title });
export const mapDelete = (id: string) => rpc<boolean>('extras.mapDelete', { id });
export const mapRestore = (id: string) => rpc<boolean>('extras.mapRestore', { id });
export const mapPurge = (id: string) => rpc<boolean>('extras.mapPurge', { id });
export const pinAdd = (input: { mapId: string; pageId?: string; label?: string; x: number; y: number }) =>
  rpc<MapPin>('extras.pinAdd', input);
/** An empty `pageId` turns the pin into a free label. */
export const pinUpdate = (
  id: string,
  patch: { pageId?: string; label?: string; x?: number; y?: number },
) => rpc<MapPin>('extras.pinUpdate', { id, ...patch });
export const pinDelete = (id: string) => rpc<boolean>('extras.pinDelete', { id });
/** The maps a page has a pin on. */
export const pageMaps = (pageId: string) => rpc<PinPlace[]>('extras.pageMaps', { pageId });
