/** Prose checks with no AI, and reading aloud. */

import '../styles/prosecheck.css';

export { ProsePanelHost } from './ProsePanel';
export { registerProse } from './register';
export { setProseOpen, useProse } from './store';
export { analyze, segmentsFromDoc, type ProseReport } from './analyze';
