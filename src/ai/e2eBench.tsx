/**
 * Used only by the E2E tests. A real manuscript editor for a scene, so the AI flow can be
 * driven there without depending on the novel-writing screens. It is reachable only when
 * the app runs under the test harness.
 */

import { listen } from '@tauri-apps/api/event';
import { createRoot, type Root } from 'react-dom/client';

import * as coreApi from '../lib/api';
import { RichEditor, useDocSaver } from '../editor';
import type { Node, PmNode } from '../lib/types';
import * as client from './client';
import { defaultLore } from './context';
import { runTool } from './tools';
import type { ToolCallBlock } from './types';
import { getStorySoFar } from './summaries/api';
import { runSummaries, useSummaryStatus, watchForSummaries } from './summaries/worker';
import * as vision from './vision';

function SceneBench({ node, editable }: { node: Node; editable: boolean }) {
  const { schedule } = useDocSaver<PmNode>((doc) => coreApi.nodes.update(node.id, { content: doc }));
  return (
    <div className="ai-e2e-bench">
      <RichEditor
        docKey={node.id}
        content={node.content}
        editable={editable}
        variant="manuscript"
        source={{ kind: 'node', id: node.id, title: node.title }}
        onChange={(doc) => schedule(doc)}
      />
    </div>
  );
}

let root: Root | null = null;

async function mountScene(nodeId: string, editable = true): Promise<void> {
  const node = await coreApi.nodes.get(nodeId);
  const content = document.querySelector('.content');
  if (!content) throw new Error('The app is not showing a project.');
  // In the content area, so it lays out and scrolls as the real screen will.
  let host = document.getElementById('ai-e2e-bench');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ai-e2e-bench';
    content.prepend(host);
  }
  root?.unmount();
  root = createRoot(host);
  root.render(<SceneBench node={node} editable={editable} />);
}

function unmount(): void {
  root?.unmount();
  root = null;
  document.getElementById('ai-e2e-bench')?.remove();
}

/** Called once at startup when the app is under the test harness. */
export function installE2eBench(): void {
  (window as unknown as { __aiE2e?: unknown }).__aiE2e = {
    mountScene,
    unmount,
    client: () => client,
    vision: () => vision,
    summaries: () => ({
      runSummaries,
      getStorySoFar,
      status: () => useSummaryStatus.getState(),
      watch: (quietMs: number) =>
        watchForSummaries((listener) => {
          void listen<{ entity: string }>('data://changed', (event) => listener(event.payload.entity));
        }, quietMs),
    }),
    tools: () => ({
      runLoreTool: (call: ToolCallBlock, forCloud = false) => runTool(call, { lore: defaultLore(), limit: null, forCloud }),
    }),
  };
}
