// Writes examples/The Saltmarch.lorecraft from the app's built-in sample world, through the real app.
import { resolve } from 'node:path';
import { createWorkspace, launch, rpc, allowPath } from './harness.mjs';
const target = resolve('examples/The Saltmarch.lorecraft');
const ws = createWorkspace();
const app = await launch(ws);
try {
  await app.page.getByRole('button', { name: 'Open sample world' }).click();
  await app.page.getByText(/Opened the sample world/).waitFor({ timeout: 60000 });
  await allowPath(app.page, target);
  const status = await rpc(app.page, 'project.saveAs', { path: target });
  console.log('saved', status.path, 'pages:', (await rpc(app.page, 'pages.list', {})).length ?? '');
} finally {
  await app.kill();
}
