/**
 * Story structure templates. Each is a list of beats with short guidance and a rough place in
 * the story, as a percentage. The names and wording are generic and our own.
 */

import { t } from '../lib/i18n';

export interface Beat {
  name: string;
  guidance: string;
  /** Roughly where it falls, from 0 (the opening) to 100 (the last page). */
  at: number;
}

export interface Structure {
  id: string;
  name: string;
  description: string;
  beats: Beat[];
}

const beat = (name: string, guidance: string, at: number): Beat => ({ name, guidance, at });

/** Read when shown, so they follow the interface language. */
export function structures(): Structure[] {
  return [
    {
      id: 'threeAct',
      name: t('Three acts'),
      description: t('Setup, confrontation and resolution, with turning points between them.'),
      beats: [
        beat(t('Setup'), t('Show the main character’s ordinary life and what they want.'), 0),
        beat(t('Inciting incident'), t('Something disrupts that life.'), 10),
        beat(t('First turning point'), t('The main character commits, and there is no going back.'), 25),
        beat(t('Rising complications'), t('Obstacles grow, and allies and enemies take shape.'), 37),
        beat(t('Midpoint'), t('A discovery or reversal changes what the story is about.'), 50),
        beat(t('Things fall apart'), t('Pressure builds and plans go wrong.'), 62),
        beat(t('Lowest point'), t('All seems lost. The main character must change to go on.'), 75),
        beat(t('Climax'), t('The final confrontation decides the outcome.'), 88),
        beat(t('Resolution'), t('Show the new normal and what it cost.'), 97),
      ],
    },
    {
      id: 'herosJourney',
      name: t('The hero’s journey'),
      description: t('A hero leaves the known world, is tested, and comes back changed.'),
      beats: [
        beat(t('The known world'), t('The hero at home, with a lack they may not see.'), 0),
        beat(t('The call'), t('A problem or offer pulls the hero toward the unknown.'), 8),
        beat(t('Holding back'), t('Fear or duty makes the hero hesitate.'), 14),
        beat(t('Crossing over'), t('The hero leaves the known world behind.'), 25),
        beat(t('Tests and allies'), t('The hero learns the new rules, makes friends and enemies.'), 35),
        beat(t('Nearing the heart'), t('The hero prepares for the greatest danger.'), 48),
        beat(t('The ordeal'), t('A crisis where the hero faces death or deep loss.'), 58),
        beat(t('The prize'), t('The hero survives and gains something new.'), 68),
        beat(t('The way back'), t('The hero heads home, but danger follows.'), 80),
        beat(t('Return, changed'), t('The hero comes home transformed, bringing something to share.'), 95),
      ],
    },
    {
      id: 'storyCircle',
      name: t('Story circle'),
      description: t('Eight steps around a circle: want, go, find, pay, return, change.'),
      beats: [
        beat(t('Comfort'), t('A character in a familiar place.'), 0),
        beat(t('Want'), t('They want something.'), 12),
        beat(t('Into the unknown'), t('They enter an unfamiliar situation.'), 25),
        beat(t('Adapt'), t('They struggle and adapt to it.'), 37),
        beat(t('Get it'), t('They get what they wanted.'), 50),
        beat(t('Pay for it'), t('It costs them more than they expected.'), 62),
        beat(t('Go back'), t('They return to the familiar place.'), 75),
        beat(t('Changed'), t('They are different now.'), 90),
      ],
    },
    {
      id: 'sevenPoint',
      name: t('Seven points'),
      description: t('Start from the ending and its opposite, then fill in the turns between.'),
      beats: [
        beat(t('Starting state'), t('Where the character begins, the opposite of where they end.'), 0),
        beat(t('First turn'), t('An event sets the story moving.'), 15),
        beat(t('First squeeze'), t('Opposition applies pressure and forces action.'), 30),
        beat(t('Middle shift'), t('The character stops reacting and starts acting.'), 50),
        beat(t('Second squeeze'), t('Things get worse. A plan fails or an ally is lost.'), 62),
        beat(t('Second turn'), t('The character finds the last piece they need.'), 75),
        beat(t('Ending state'), t('The character reaches the end, changed.'), 95),
      ],
    },
    {
      id: 'beatSheet',
      name: t('Beat sheet'),
      description: t('A detailed list of beats for a tightly paced story.'),
      beats: [
        beat(t('Opening image'), t('A snapshot of the world and the main character before the change.'), 0),
        beat(t('Setting the scene'), t('Show what is missing in the main character’s life.'), 5),
        beat(t('The spark'), t('An event that changes everything.'), 11),
        beat(t('Second thoughts'), t('The main character weighs whether to act.'), 17),
        beat(t('Into the new'), t('A choice that leads into a new situation.'), 24),
        beat(t('Promise of the premise'), t('The fun and trouble the premise promised.'), 35),
        beat(t('Midway turn'), t('A false win or false loss raises the stakes.'), 50),
        beat(t('Closing in'), t('Enemies regroup, and doubts and problems grow.'), 60),
        beat(t('Everything lost'), t('The lowest moment. Something or someone is lost.'), 72),
        beat(t('Dark night'), t('The main character takes in the loss.'), 78),
        beat(t('The answer'), t('A new idea shows the way forward.'), 82),
        beat(t('Finale'), t('The plan is carried out and the conflict is settled.'), 88),
        beat(t('Closing image'), t('A snapshot that mirrors the opening, showing the change.'), 99),
      ],
    },
    {
      id: 'romance',
      name: t('Romance arc'),
      description: t('Two people meet, resist, fall, break apart and choose each other.'),
      beats: [
        beat(t('Two lives'), t('Each lead alone, with a wound or a need.'), 0),
        beat(t('The meeting'), t('The leads meet, and sparks or friction fly.'), 10),
        beat(t('Reasons to resist'), t('Why this could never work.'), 20),
        beat(t('Drawn together'), t('Circumstances keep pushing them together.'), 33),
        beat(t('Getting close'), t('A moment of real closeness or a first kiss.'), 50),
        beat(t('Doubts return'), t('The old fears and obstacles come back.'), 62),
        beat(t('The break'), t('They split apart. It looks like the end.'), 75),
        beat(t('The big gesture'), t('One or both risk everything to win the other back.'), 88),
        beat(t('Together'), t('They choose each other, and the future looks bright.'), 97),
      ],
    },
    {
      id: 'mystery',
      name: t('Mystery'),
      description: t('A crime, an investigation full of false leads, and the truth revealed.'),
      beats: [
        beat(t('The crime'), t('A crime or puzzle that demands an answer.'), 0),
        beat(t('Taking the case'), t('The investigator gets involved, and why it matters to them.'), 10),
        beat(t('First clues'), t('Early evidence and the first suspects.'), 22),
        beat(t('Suspects and secrets'), t('Each suspect hides something.'), 35),
        beat(t('A wrong answer'), t('A convincing theory that turns out to be false.'), 50),
        beat(t('Raising the stakes'), t('Another crime, or the investigator is in danger.'), 62),
        beat(t('The missing piece'), t('A small detail makes everything fall into place.'), 78),
        beat(t('The reveal'), t('The truth is laid out and the culprit faces it.'), 88),
        beat(t('Order restored'), t('The aftermath, and what it changed.'), 97),
      ],
    },
  ];
}

export function structureById(id: string | null | undefined): Structure | undefined {
  return id ? structures().find((s) => s.id === id) : undefined;
}
