import { rpc } from '../lib/rpc';

export interface McpClient {
  name: string;
  version: string;
  connected: boolean;
  firstSeen: string;
  lastSeen: string;
}

/** One tool call. It holds names only, never any text from the project. */
export interface McpActivity {
  at: string;
  client: string;
  tool: string;
  ok: boolean;
}

export type McpPermission = 'read' | 'suggest';

export interface McpStatus {
  enabled: boolean;
  running: boolean;
  port: number | null;
  url: string | null;
  token: string;
  permission: McpPermission;
  shareLocalOnly: boolean;
  exePath: string | null;
  projectPath: string | null;
  projectName: string;
  projectOpen: boolean;
  clients: McpClient[];
  activity: McpActivity[];
  error: string | null;
}

export interface EditPayload {
  quote: string;
  replacement: string;
  reason?: string;
}

export interface NewPagePayload {
  title: string;
  pageType: string;
  body: string;
  summary?: string;
  infobox?: { label: string; value: string }[];
  aliases?: string[];
  categories?: string[];
  reason?: string;
}

interface ProposalBase {
  id: string;
  client: string;
  title: string;
  status: string;
  createdAt: string;
}

/** A stretch from `fromQuote` to `toQuote`, or the whole document, rewritten. */
export interface RewritePayload {
  mode: 'range' | 'whole';
  fromQuote?: string;
  toQuote?: string;
  replacement: string;
  /** The text replaced, as it was when suggested. For a whole rewrite, all of it. */
  original?: string;
  reason?: string;
}

export interface InsertPayload {
  at: 'start' | 'end' | 'after' | 'before';
  quote?: string;
  text: string;
  reason?: string;
}

/** A page named in a suggestion, as the server resolved it. */
export interface PageRef {
  id: string;
  title: string;
}

export interface NewScenePayload {
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  afterId?: string;
  afterTitle?: string;
  title: string;
  synopsis?: string;
  pov?: PageRef;
  location?: PageRef;
  cast?: PageRef[];
  text?: string;
  reason?: string;
}

export interface NewChapterPayload {
  bookId: string;
  bookTitle: string;
  parentId?: string | null;
  afterId?: string;
  afterTitle?: string;
  title: string;
  synopsis?: string;
  scene: { title: string; synopsis?: string; pov?: PageRef; location?: PageRef; cast?: PageRef[]; text?: string };
  reason?: string;
}

export interface SceneDetails {
  title?: string;
  synopsis?: string;
  status?: string;
  storyDate?: string;
  notes?: string;
  /** Null clears it. */
  pov?: PageRef | null;
  location?: PageRef | null;
  cast?: PageRef[];
}

export interface SceneDetailsPayload {
  changes: SceneDetails;
  before: SceneDetails;
  reason?: string;
}

export type Proposal =
  | (ProposalBase & { kind: 'edit'; targetKind: 'page' | 'node'; targetId: string; payload: EditPayload })
  | (ProposalBase & { kind: 'rewrite'; targetKind: 'page' | 'node'; targetId: string; payload: RewritePayload })
  | (ProposalBase & { kind: 'insert'; targetKind: 'page' | 'node'; targetId: string; payload: InsertPayload })
  | (ProposalBase & { kind: 'newScene'; targetKind: 'node'; targetId: string; payload: NewScenePayload })
  | (ProposalBase & { kind: 'newChapter'; targetKind: 'book'; targetId: string; payload: NewChapterPayload })
  | (ProposalBase & { kind: 'sceneDetails'; targetKind: 'node'; targetId: string; payload: SceneDetailsPayload })
  | (ProposalBase & { kind: 'newPage'; targetKind: null; targetId: null; payload: NewPagePayload });

/** A suggestion that changes the text of one document, and can be reviewed inside it. */
export type TextProposal = Extract<Proposal, { kind: 'edit' | 'rewrite' | 'insert' }>;

export function isTextProposal(proposal: Proposal): proposal is TextProposal {
  return proposal.kind === 'edit' || proposal.kind === 'rewrite' || proposal.kind === 'insert';
}

export const mcp = {
  status: () => rpc<McpStatus>('mcp.status'),
  update: (patch: { enabled?: boolean; permission?: McpPermission; shareLocalOnly?: boolean }) =>
    rpc<McpStatus>('mcp.update', patch),
  rotateToken: () => rpc<McpStatus>('mcp.rotateToken'),
  proposals: () => rpc<Proposal[]>('mcp.proposals'),
  proposalCount: () => rpc<number>('mcp.proposalCount'),
  /** `target` names a document that was just replaced, so an open editor reloads it. */
  resolve: (id: string, status: 'accepted' | 'rejected', target?: { targetKind: string; targetId: string }) =>
    rpc<{ changed: boolean }>('mcp.proposalResolve', { id, status, ...target }),
};
