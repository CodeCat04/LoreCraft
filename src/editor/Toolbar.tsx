import type { ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';

import { runCommand } from '../shell/commands';
import { startWikiLink } from './linkAutocomplete';
import { insertPageList } from './pageListView';
import { insertReference } from './references';
import { promptText } from '../shell/dialogs';
import { ICONS } from './figure/icons';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

function Icon({ svg }: { svg: string }) {
  return <span className="tool-icon" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function ToolButton(props: {
  label: ReactNode;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`tool-btn${props.active ? ' is-active' : ''} ${props.className ?? ''}`}
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      disabled={props.disabled}
      // Keeps the selection in the editor when a button is clicked.
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

async function setLink(editor: Editor) {
  const current = String(editor.getAttributes('link').href ?? '');
  const href = await promptText({
    title: t('Web link'),
    label: t('Address'),
    initial: current || 'https://',
    placeholder: 'https://example.com',
  });
  if (href === null) return;
  if (!href || href === 'https://') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
  } else {
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }
}

export function Toolbar({ editor, variant }: { editor: Editor; variant?: 'article' | 'manuscript' }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  useLocale();
  const chain = () => editor.chain().focus();
  return (
    <div className="toolbar" role="toolbar" aria-label={t('Formatting')}>
      <ToolButton label="↶" title={t('Undo ({shortcut})', { shortcut: 'Ctrl+Z' })} disabled={!s.canUndo} onClick={() => chain().undo().run()} />
      <ToolButton label="↷" title={t('Redo ({shortcut})', { shortcut: 'Ctrl+Y' })} disabled={!s.canRedo} onClick={() => chain().redo().run()} />
      <span className="toolbar-sep" />
      <ToolButton label="B" title={t('Bold ({shortcut})', { shortcut: 'Ctrl+B' })} className="tb-bold" active={s.bold} onClick={() => chain().toggleBold().run()} />
      <ToolButton label="I" title={t('Italic ({shortcut})', { shortcut: 'Ctrl+I' })} className="tb-italic" active={s.italic} onClick={() => chain().toggleItalic().run()} />
      <ToolButton label="U" title={t('Underline ({shortcut})', { shortcut: 'Ctrl+U' })} className="tb-underline" active={s.underline} onClick={() => chain().toggleUnderline().run()} />
      <ToolButton label="S" title={t('Strikethrough')} className="tb-strike" active={s.strike} onClick={() => chain().toggleStrike().run()} />
      <span className="toolbar-sep" />
      <ToolButton label="H2" title={t('Section heading')} active={s.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()} />
      <ToolButton label="H3" title={t('Subsection heading')} active={s.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()} />
      <span className="toolbar-sep" />
      <ToolButton label="•" title={t('Bulleted list')} active={s.bullet} onClick={() => chain().toggleBulletList().run()} />
      <ToolButton label="1." title={t('Numbered list')} active={s.ordered} onClick={() => chain().toggleOrderedList().run()} />
      <ToolButton label="❝" title={t('Quote')} active={s.quote} onClick={() => chain().toggleBlockquote().run()} />
      <ToolButton label="🔗" title={t('Web link')} active={s.link} onClick={() => void setLink(editor)} />
      <span className="toolbar-sep" />
      <ToolButton label="[[ ]]" title={t('Link to a page (type [[)')} onClick={() => startWikiLink(editor)} />
      {variant === 'article' && (
        <>
          <ToolButton label="[1]" title={t('Add a reference')} onClick={() => void insertReference(editor)} />
          <ToolButton label="≡" title={t('Insert a list of pages')} onClick={() => void insertPageList(editor)} />
        </>
      )}
      <span className="toolbar-sep" />
      <ToolButton label={<Icon svg={ICONS.picture} />} title={t('Insert picture')} onClick={() => void runCommand('insert.picture')} />
      <ToolButton label={<Icon svg={ICONS.video} />} title={t('Insert video')} onClick={() => void runCommand('insert.video')} />
      <ToolButton label={<Icon svg={ICONS.table} />} title={t('Insert table')} onClick={() => void runCommand('insert.table')} />
    </div>
  );
}
