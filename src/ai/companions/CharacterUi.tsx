/** The parts of the AI pane and a wiki page that have to do with talking to a character. */

import { useMemo } from 'react';

import { t } from '../../lib/i18n';
import { useLocale } from '../../state/language';
import { useTitles } from '../../state/project';
import { toast } from '../../shell/toasts';
import { StoryLimit } from '../ContextView';
import { usePane } from '../store';
import type { CharacterRef } from '../types';
import { characterPages, saveReplyAsNote, startCharacterChat } from './actions';

/** Which character the pane's conversation is with, if any. */
export function useChatCharacter(): CharacterRef | undefined {
  return usePane((s) => (s.conversation?.context ?? s.pendingSettings).character);
}

function useCurrentTitle(character: CharacterRef): string {
  // Follows a rename. The conversation only keeps the name from when it began.
  return useTitles((s) => s.byId.get(character.pageId)?.title) ?? character.title;
}

/** On a character's page. */
export function TalkToCharacterButton({ pageId, title }: { pageId: string; title: string }) {
  useLocale();
  return (
    <button
      type="button"
      className="btn btn-sm"
      title={t('Start a chat where the AI plays {name}. Nothing in it changes canon.', { name: title })}
      onClick={() => startCharacterChat({ pageId, title })}
    >
      {t('Talk to this character')}
    </button>
  );
}

/** In the pane's header. */
export function CharacterPicker() {
  useLocale();
  const entries = useTitles((s) => s.entries);
  const characters = useMemo(() => characterPages(entries), [entries]);
  return (
    <select
      className="select ai-character-pick"
      aria-label={t('Talk to a character')}
      title={characters.length === 0 ? t('Give a page the type Character to talk to it here.') : t('Start a chat where the AI plays a character')}
      disabled={characters.length === 0}
      value=""
      onChange={(e) => {
        const found = characters.find((c) => c.id === e.target.value);
        if (found) startCharacterChat({ pageId: found.id, title: found.title });
      }}
    >
      <option value="">{t('Talk to…')}</option>
      {characters.map((c) => (
        <option key={c.id} value={c.id}>{c.title}</option>
      ))}
    </select>
  );
}

/** Says plainly what this chat is, for as long as it is on screen. */
export function CharacterBanner({ character }: { character: CharacterRef }) {
  useLocale();
  const title = useCurrentTitle(character);
  const asOf = usePane((s) => (s.conversation?.context ?? s.pendingSettings).asOfNodeId);
  const updateSettings = usePane((s) => s.updateSettings);
  return (
    <div className="ai-character-banner" role="note" data-testid="ai-character-banner">
      <div className="ai-character-head">
        <strong>{t('Talking to {name}', { name: title })}</strong>
        <span className="badge">{t('AI playing a character')}</span>
      </div>
      <p className="small muted">
        {t('This is the model in character, working from the wiki. It may be wrong about them, and nothing said here changes canon.')}
      </p>
      <StoryLimit value={asOf} onChange={(id) => void updateSettings({ asOfNodeId: id })} />
    </div>
  );
}

/** Shown over each reply, so a line copied from a long chat is not mistaken for fact. */
export function CharacterSpeaker({ character }: { character: CharacterRef }) {
  useLocale();
  const title = useCurrentTitle(character);
  return <div className="ai-character-speaker">{t('{name} (AI)', { name: title })}</div>;
}

export function CharacterEmptyChat({ character }: { character: CharacterRef }) {
  useLocale();
  const title = useCurrentTitle(character);
  return (
    <div className="ai-empty">
      <p>{t('Say something to {name}.', { name: title })}</p>
      <p className="faint small">{t('They know what their page and scenes establish. They should say so when something is not established.')}</p>
    </div>
  );
}

/** What can be done with one reply: never put it in the book, only keep it as a note. */
export function CharacterReplyActions({ character, text }: { character: CharacterRef; text: string }) {
  useLocale();
  return (
    <div className="ai-actions" role="group" aria-label={t('Use this reply')}>
      <button
        type="button"
        className="btn btn-sm"
        title={t("Copy this reply to the Talk tab of the character's page")}
        onClick={() => void saveReplyAsNote(character, text)}
      >
        {t('Save as note')}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => void navigator.clipboard.writeText(text).catch(() => toast(t('Could not copy that.'), 'error'))}
      >
        {t('Copy')}
      </button>
    </div>
  );
}
