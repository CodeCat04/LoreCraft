import { registerWiki } from '../wiki';
import { registerWrite } from '../write';
import { registerAi } from '../ai';
import { registerConsistency } from '../consistency';
import { registerExtras } from '../extras';
import { registerExporters } from '../exporters';
import { registerMcp } from '../mcp';
import { registerHelp } from '../help';
import { registerFind } from '../editor/find';
import { registerMakePage } from '../editor/makePage';
import { registerInbox } from '../inbox';
import { registerSupport } from '../support';
import { registerMeaning } from '../meaning';
import { registerMedia } from '../media';
import { registerWritingStyles } from '../writingStyles';
import { registerNotes } from '../notes';
import { registerProse } from '../prose';
import { registerCanvas } from '../canvas';
import { registerBrainstorm } from '../brainstorm';

/** Lets every feature module add its commands. Runs once at startup. */
export function registerModules() {
  registerHelp();
  registerWiki();
  registerWrite();
  registerAi();
  registerConsistency();
  // Before extras, whose window guard marks every file drop as handled. Media has to see
  // one first, to put it in the document on screen.
  registerMedia();
  registerExtras();
  registerExporters();
  registerMcp();
  registerWritingStyles();
  registerFind();
  registerMakePage();
  registerInbox();
  registerSupport();
  registerNotes();
  registerProse();
  registerMeaning();
  registerCanvas();
  registerBrainstorm();
}
