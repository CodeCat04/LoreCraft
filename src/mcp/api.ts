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

export type Proposal =
  | (ProposalBase & { kind: 'edit'; targetKind: 'page' | 'node'; targetId: string; payload: EditPayload })
  | (ProposalBase & { kind: 'newPage'; targetKind: null; targetId: null; payload: NewPagePayload });

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
