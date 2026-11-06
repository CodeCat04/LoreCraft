/**
 * The sample world, written for LoreCraft, in the format of docs/IMPORT_FORMAT.md. Help >
 * Open sample world imports it into a new project. It has three deliberate mistakes for the
 * consistency checker to find, listed on its "About this sample" page and in `PLANTED` below.
 *
 * Dates are year-month-day counted from the first causeway, because that is the shape
 * `parseStoryDate` can put in order.
 */

import { templateFor } from '../wiki/templates';

export const SAMPLE_WORLD_NAME = 'The Saltmarch';

type FieldValues = Record<string, string | string[]>;
type FieldChanges = Record<string, { date: string; value: string; note: string }[]>;

/** The fields of the wiki's template for this type, with these values filled in. */
function infobox(type: string, values: FieldValues, changes: FieldChanges = {}) {
  return {
    fields: templateFor(type).fields.map((field) => ({
      key: field.key,
      label: field.label,
      kind: field.kind,
      value: values[field.key] ?? '',
      ...(changes[field.key] ? { changes: changes[field.key] } : {}),
    })),
  };
}

/** The mistakes planted on purpose. A test checks that the data really contains them. */
export const PLANTED = {
  /** A character in a scene dated after their death. */
  appearsAfterDeath: { character: 'Oswin Halloway', scene: 'The Guildhall Stair' },
  /** Two pages for one person. */
  nearDuplicateNames: ['Bram Ketteridge', 'Bram Kettridge'],
  /** The manuscript contradicts an infobox. Finding this one takes the AI check. */
  contradictsInfobox: { character: 'Wren Halloway', field: 'eyes', scene: 'Out on the Flats', said: 'brown eyes' },
};

export const SAMPLE_PAGES = [
  {
    title: 'The Saltmarch',
    pageType: 'home',
    status: 'canon',
    isHome: true,
    summary: 'A low country of salt flats and causeways, where the sea covers the roads twice a day.',
    aliases: ['Saltmarch'],
    categories: ['Places'],
    content: `Welcome to **the Saltmarch**, a small invented world to explore. It was written to show how LoreCraft works, and you can change anything in it. Nothing here touches your own projects.

The Saltmarch is a low country of salt flats and reed channels, where the sea covers the roads twice a day. People cross it on raised causeways, and after dark only the lamps of [[The Lamplighters Guild]] show where the road is.

## Start here

- [[Wren Halloway]], an apprentice lamplighter and the hero of the sample book
- [[Cray Landing]], the causeway town she calls home
- [[The Long Flood]], the disaster that still shapes the marsh
- [[About this sample]], which lists the mistakes planted here for the consistency checker to find

## Things to try

- Open **Write** to read *The Unlit Road*, a short book of two chapters. Hold the pointer over a name in a scene to see what the wiki says about it.
- Click a red link, such as [[The Tithe Barges]], to create that page.
- Open **Atlas** to see the timeline and the relationship graph built from these pages.
- Open **Consistency** to see what the checks make of it all.`,
  },
  {
    title: 'About this sample',
    pageType: 'article',
    status: 'draft',
    summary: 'Not part of the story. Lists the mistakes planted in this world, and where to find them.',
    categories: ['About this sample'],
    content: `This page is not part of the story. It lists the mistakes planted in this world on purpose, so that the consistency checker has something to find.

## The planted mistakes

1. **A dead man on the stairs.** [[Oswin Halloway]] died on 409-11-02, according to his infobox and to [[The Long Flood]]. Yet he sits on a window ledge and talks to his daughter in the scene “The Guildhall Stair”, which is dated 412-03-16. This is a timeline error.
2. **One man, two pages.** [[Bram Ketteridge]] and [[Bram Kettridge]] are the same person, spelled two ways. This is a near-duplicate name.
3. **The wrong eyes.** The infobox of [[Wren Halloway]] says her eyes are grey, and so does her article. The scene “Out on the Flats” gives her brown eyes. Only the AI check can find this one, because it has to read the prose and compare it with the wiki.

## Not mistakes

- [[The Tithe Barges]] and [[Hob Corrow]] are red links, because those pages have not been written yet. They appear under wanted pages.
- [[The Drowned Quarter]] is marked as retconned, so the AI does not treat it as true.
- [[The Ferry Compact]] is still an idea, and [[Lamp Tithe]] is a draft, so the AI treats them with less certainty than canon pages.

## How the dates work

Years are counted from the first causeway, and a date is written as year, month and day. A date in this shape can be put in order, so the timeline and the checks can use it.`,
  },
  {
    title: 'Wren Halloway',
    pageType: 'character',
    status: 'canon',
    summary: 'An apprentice lamplighter of Cray Landing, and the daughter of Oswin Halloway.',
    aliases: ['Wren', 'Little Wick', 'Wren of the Landing'],
    categories: ['Characters', 'Lamplighters'],
    infobox: infobox('character', {
      born: '391-02-11',
      gender: 'Woman',
      height: 'Short',
      eyes: 'Grey',
      hair: 'Black, cropped',
      location: 'Cray Landing',
      affiliation: ['The Lamplighters Guild'],
      parents: ['Oswin Halloway'],
    }),
    content: `**Wren Halloway** is an apprentice of [[The Lamplighters Guild]] at [[Cray Landing]], and the daughter of the master lamplighter [[Oswin Halloway]].

## Appearance

Small and quick, with black hair cropped short to keep it out of the flame, and her father’s grey eyes. Her hands are marked with old oil burns.

## Personality

Stubborn, exact and not much given to talk. She counts things when she is frightened.

## Biography

Wren was born at Cray Landing in 391 and apprenticed to the Guild at twelve. She was eighteen when her father died at [[Greywater Light]] in [[The Long Flood]], and she inherited [[The Tallow Key]] from him.

## Relationships

Her closest friend is the ferryman [[Tam Corrow]]. She regards the Guildmistress, [[Isolde Marrable]], with wary respect, and the harbor reeve, [[Bram Ketteridge]], with something close to affection.`,
    notes: 'Does she stay with the Guild after book one? Leave this open for now.',
  },
  {
    title: 'Oswin Halloway',
    pageType: 'character',
    status: 'canon',
    summary: 'A master lamplighter and the last keeper of Greywater Light. He drowned in the Long Flood.',
    aliases: ['Oswin', 'Master Halloway', 'Old Oswin'],
    categories: ['Characters', 'Lamplighters'],
    infobox: infobox('character', {
      born: '365-01-17',
      died: '409-11-02',
      gender: 'Man',
      height: 'Tall, stooped',
      eyes: 'Grey',
      hair: 'Grey',
      location: 'Greywater Light',
      affiliation: ['The Lamplighters Guild'],
      children: ['Wren Halloway'],
    }),
    content: `**Oswin Halloway** was a master lamplighter of [[The Lamplighters Guild]], the last keeper of [[Greywater Light]] and the father of [[Wren Halloway]].

## Personality

Patient and dry-humored. He trimmed wicks with the same hooked knife for thirty years, and he was known for saying that the figures are always wrong, and that what matters is who they are wrong for.

## Biography

Oswin was born at [[Cray Landing]] in 365 and joined the Guild as a boy. He made [[The Tallow Key]] in 401, when the old locks at Greywater failed. In the autumn of 409 he stayed at his post to keep the lamp burning through [[The Long Flood]]. On the third night the sea door gave way, and he drowned on the stair. He is buried at Cray Landing.`,
  },
  {
    title: 'Isolde Marrable',
    pageType: 'character',
    status: 'canon',
    summary: 'The Guildmistress of the Lamplighters Guild, who runs it from the Guildhall at Cray Landing.',
    aliases: ['Isolde', 'Marrable', 'Guildmistress'],
    categories: ['Characters', 'Lamplighters'],
    infobox: infobox('character', {
      born: '354-09-20',
      gender: 'Woman',
      eyes: 'Pale blue',
      hair: 'White',
      location: 'Cray Landing',
      affiliation: ['The Lamplighters Guild'],
    }),
    content: `**Isolde Marrable** is the Guildmistress of [[The Lamplighters Guild]], a post she has held for twenty-six years.

## Personality

Careful and unhurried. She remembers what she owes and who she owes it to, and is said to care for neither.

## Biography

She came up through the Guild’s counting room rather than its lamps, which the older lamplighters have never forgiven. She held the Guild together after [[The Long Flood]], when half of the causeway lamps were gone and the [[Lamp Tithe]] was the only money coming in.`,
    notes: 'Does she know where the oil is really going? Decide this before chapter three.',
  },
  {
    title: 'Tam Corrow',
    pageType: 'character',
    status: 'draft',
    summary: 'A ferryman of the flats and a member of the Ferry Compact, and Wren’s closest friend.',
    aliases: ['Tam', 'Tam the Ferry'],
    categories: ['Characters', 'Ferrymen'],
    infobox: infobox('character', {
      born: '389-07-30',
      gender: 'Man',
      eyes: 'Brown',
      hair: 'Red',
      location: 'Cray Landing',
      affiliation: ['The Ferry Compact'],
      parents: ['Hob Corrow'],
    }),
    content: `**Tam Corrow** is a ferryman on the flats below [[Cray Landing]], and the son of [[Hob Corrow]] of [[The Ferry Compact]].

## Biography

Tam has rowed the channels since he was seven. His family does well whenever the causeway lamps go dark, which he and [[Wren Halloway]] have agreed not to talk about.`,
  },
  {
    title: 'Bram Ketteridge',
    pageType: 'character',
    status: 'canon',
    summary: 'The harbor reeve of Cray Landing, who counts every cart that crosses the causeway.',
    aliases: ['Bram', 'Ketteridge', 'The Reeve'],
    categories: ['Characters'],
    infobox: infobox('character', {
      born: '360-06-02',
      gender: 'Man',
      hair: 'Grey, with a large beard',
      location: 'Cray Landing',
    }),
    content: `**Bram Ketteridge** has been the harbor reeve of [[Cray Landing]] for twenty years. His office takes the town’s share of the [[Lamp Tithe]] to the Guild, and he counts every cart that comes up the causeway.

## Personality

Untidy, proud and impossible to bribe, because he has never been offered enough.`,
  },
  {
    title: 'Bram Kettridge',
    pageType: 'character',
    status: 'draft',
    summary: 'The reeve at the Landing. Counts carts.',
    categories: ['Characters'],
    infobox: infobox('character', {
      gender: 'Man',
      location: 'Cray Landing',
    }),
    content: 'The harbor reeve at [[Cray Landing]]. Counts carts. Write more about him later.',
  },
  {
    title: 'Cray Landing',
    pageType: 'place',
    status: 'canon',
    summary: 'The largest causeway town of the Saltmarch, and home of the Guildhall.',
    aliases: ['The Landing', 'Landing'],
    categories: ['Places', 'Towns'],
    infobox: infobox('place', {
      location: 'The Saltmarch',
      founded: '12',
      leader: 'Bram Ketteridge',
    }),
    content: `**Cray Landing** is the largest town in [[The Saltmarch]], built where the oldest causeway meets the water.

## Geography

The town stands on a shelf of old shingle, the only ground for miles that stays dry at every tide. From the gate, the causeway runs out over the flats on a line of lamp posts.

## History

The first houses went up in the year 12, beside the ferry steps. [[The Long Flood]] took the lower streets in 409, and they were rebuilt within three years.

## Notable places

- The Guildhall, seat of [[The Lamplighters Guild]]
- The ferry steps, where [[The Ferry Compact]] takes its fares
- The reeve’s office, where [[Bram Ketteridge]] keeps the tithe book`,
  },
  {
    title: 'Greywater Light',
    pageType: 'place',
    status: 'canon',
    summary: 'The oldest lamp in the Saltmarch, a tower out on the flats. Nobody has kept it since the Long Flood.',
    aliases: ['Greywater'],
    categories: ['Places', 'Lamps'],
    infobox: infobox('place', {
      location: 'The Saltmarch',
      founded: '118',
      dissolved: '409-11-04',
      affiliation: ['The Lamplighters Guild'],
    }),
    content: `**Greywater Light** is a stone lamp tower on the outer flats of [[The Saltmarch]]. It is the oldest lamp in the marsh, and older than [[The Lamplighters Guild]] that now owns it.

## Geography

The tower stands on a reef that shows only at low water. It has a sea door at its foot and an oil room halfway up, and the oil room opens only to [[The Tallow Key]].

## History

Greywater was lit in the year 118. Its last keeper, [[Oswin Halloway]], drowned there during [[The Long Flood]], and no keeper has been posted since. The Guild’s books still list its oil.`,
  },
  {
    title: 'The Drowned Quarter',
    pageType: 'place',
    status: 'retconned',
    summary: 'A sunken district of Cray Landing, cut from the story in the second draft.',
    categories: ['Places'],
    infobox: infobox('place', {
      location: 'Cray Landing',
    }),
    content: 'A sunken district of [[Cray Landing]], where the old town was supposed to lie under the harbor. It was cut in the second draft, because the story works better if the lower streets are rebuilt after [[The Long Flood]].',
  },
  {
    title: 'The Lamplighters Guild',
    pageType: 'faction',
    status: 'canon',
    summary: 'The guild that keeps the causeway lamps of the Saltmarch burning, paid for by the Lamp Tithe.',
    aliases: ['Lamplighters Guild', 'The Guild', 'Guild', 'The Lamplighters'],
    categories: ['Factions'],
    infobox: infobox('faction', {
      founded: '140-05-01',
      leader: 'Isolde Marrable',
      members: ['Isolde Marrable', 'Oswin Halloway', 'Wren Halloway'],
      location: 'Cray Landing',
    }),
    content: `**The Lamplighters Guild** keeps the lamps along every causeway in [[The Saltmarch]], and it has done so since the year 140.

## Goals

To keep every lamp lit, every night, at every tide. Its oath says nothing about what happens to the money.

## Structure

The Guildmistress, at present [[Isolde Marrable]], rules from the Guildhall at [[Cray Landing]]. Below her are the masters, the journeymen and the apprentices. Their lamps burn the oil of the [[Glasseel]], paid for by the [[Lamp Tithe]].

## Notable members

- [[Oswin Halloway]], last keeper of [[Greywater Light]]
- [[Wren Halloway]], his daughter and an apprentice`,
  },
  {
    title: 'The Ferry Compact',
    pageType: 'organization',
    status: 'idea',
    summary: 'The ferrymen’s brotherhood, which makes its money when the causeways are dark.',
    aliases: ['Ferry Compact', 'The Compact', 'Compact'],
    categories: ['Factions', 'Ferrymen'],
    infobox: infobox('organization', {
      founded: '233',
      leader: 'Hob Corrow',
      members: ['Tam Corrow', 'Hob Corrow'],
      location: 'Cray Landing',
    }),
    content: 'The boatmen of the flats, who take fares from anyone who cannot use the road. Perhaps the Compact is buying the missing oil. Or perhaps that is what someone wants [[Wren Halloway]] to think.',
  },
  {
    title: 'The Tallow Key',
    pageType: 'item',
    status: 'canon',
    summary: 'The iron key to the oil room of Greywater Light, made by Oswin Halloway.',
    aliases: ['Tallow Key', 'Oil-room key'],
    categories: ['Items'],
    infobox: infobox(
      'item',
      {
        creator: 'Oswin Halloway',
        date: '401-08-09',
        owner: 'Oswin Halloway',
      },
      // A fact that changes during the story, so that this is not read as a contradiction.
      { owner: [{ date: '409-11-02', value: 'Wren Halloway', note: 'Inherited when her father died.' }] },
    ),
    content: `**The Tallow Key** is an iron key made to open the oil room of [[Greywater Light]].

## Description

It is as long as a hand, and black with old oil, and it is worn on a cord. The name comes from the grease that [[Oswin Halloway]] packed into the lock to keep out the salt.

## History

Oswin made it in 401, after the old locks failed. It came to his daughter, [[Wren Halloway]], with the rest of his things after [[The Long Flood]].`,
  },
  {
    title: 'The Long Flood',
    pageType: 'event',
    status: 'canon',
    summary: 'The five-day storm tide of 409, which drowned the lower Saltmarch and killed Oswin Halloway.',
    aliases: ['Long Flood', 'The Flood of 409'],
    categories: ['Events'],
    infobox: infobox('event', {
      date: '409-11-02',
      start: '409-10-30',
      end: '409-11-04',
      location: 'The Saltmarch',
      members: ['Oswin Halloway', 'Isolde Marrable', 'Bram Ketteridge'],
    }),
    content: `**The Long Flood** was a storm tide that covered [[The Saltmarch]] for five days in the autumn of 409.

## Course of events

The sea came over the outer causeways on 409-10-30 and did not go back. On the third night it broke the sea door of [[Greywater Light]] and drowned its keeper, [[Oswin Halloway]]. At [[Cray Landing]], [[Bram Ketteridge]] kept the ferry steps open by lantern until the water reached the second street.

## Aftermath

Half of the causeway lamps were lost. [[Isolde Marrable]] raised the [[Lamp Tithe]] to pay for new ones, and it has not come down since.`,
  },
  {
    title: 'Lamp Tithe',
    pageType: 'concept',
    status: 'draft',
    summary: 'The quarterly levy every causeway town pays to the Lamplighters Guild for lamp oil.',
    aliases: ['The Tithe'],
    categories: ['Customs'],
    infobox: infobox('concept', {
      creator: 'The Lamplighters Guild',
      date: '151',
    }),
    content: `The **Lamp Tithe** is the levy that every causeway town pays each quarter to [[The Lamplighters Guild]], in return for oil and upkeep.

## In practice

Each town’s reeve records the payment and the casks delivered against it in a tithe book. At [[Cray Landing]], [[Bram Ketteridge]] keeps the book and counts the carts. How the oil leaves the marsh is a matter for [[The Tithe Barges]].`,
  },
  {
    title: 'Glasseel',
    pageType: 'species',
    status: 'canon',
    summary: 'A pale, faintly glowing eel of the salt channels, whose oil burns in all the lamps of the Saltmarch.',
    aliases: ['glasseel', 'Glass eel', 'Lantern eel'],
    categories: ['Creatures'],
    infobox: infobox('species', {
      location: 'The Saltmarch',
      height: 'As long as a forearm',
      eyes: 'Small and milky',
    }),
    content: `The **glasseel** is a pale eel of the salt channels, so thin that its spine shows through its skin.

## Biology

Its fat holds a faint light that lasts after death. Rendered down, it makes an oil that burns low and blue, and it burns in wind and in rain.

## Behavior

Glasseels rise in the channels at slack water and sink when the tide moves. [[The Lamplighters Guild]] buys every cask that the marsh can render.`,
  },
];

const MISSING_OIL = 'The missing oil';
const WREN_AND_TAM = 'Wren and Tam';

export const SAMPLE_THREADS = [
  { name: MISSING_OIL, color: 'warning', description: 'The towns pay for oil that never reaches the lamps. Where is it going?', position: 0 },
  { name: WREN_AND_TAM, color: 'link', description: 'A lamplighter and a ferryman, who profit from opposite things.', position: 1 },
];

export const SAMPLE_BOOK = {
  title: 'The Unlit Road',
  subtitle: 'A sample novel',
  author: 'The LoreCraft sample',
  targetWords: 60000,
  children: [
    {
      kind: 'chapter',
      title: 'The Dark Posts',
      synopsis: 'The causeway lamps are failing, and the tithe book says they should not be.',
      children: [
        {
          kind: 'scene',
          title: 'Eleven Dark Posts',
          status: 'revised',
          pov: 'Wren Halloway',
          storyDate: '412-03-14',
          location: 'Cray Landing',
          cast: ['Wren Halloway', 'Tam Corrow'],
          threads: [MISSING_OIL, WREN_AND_TAM],
          synopsis: 'Wren finds the lamps on the causeway dry, and takes Tam’s ferry home.',
          content: `The lamps along the causeway had gone out one by one, and nobody had come to fill them.

Wren Halloway counted eleven dark posts between the gate of Cray Landing and the water. The twelfth still held a little light, low and blue, the way glasseel oil burned when it was nearly spent. She unhooked her pole and climbed the post anyway, because an apprentice of the Lamplighters Guild did not walk past a lamp.

The reservoir was dry. Not low: dry, and wiped clean.

“Leave it,” Tam Corrow called from the ferry steps. He had tied up early and sat with his boots over the edge, watching the tide feel its way up the channel. “You’ll not fill it from that flask.”

“It’s the Guild’s lamp.”

“Aye, and it’s the Guild’s tithe, and the reeve’s been asking where that went too.” He nodded at the flats. In an hour the water would be over the road, and anyone still walking it would have only the posts to steer by. “Get in the boat, Wren. No charge. I’d hate to lose a paying customer to a dark road.”

She looked back along the line of posts. Then she climbed down and got in the boat.`,
        },
        {
          kind: 'scene',
          title: 'The Tithe Book',
          status: 'draft',
          pov: 'Wren Halloway',
          storyDate: '412-03-15',
          location: 'Cray Landing',
          cast: ['Wren Halloway', 'Bram Ketteridge'],
          threads: [MISSING_OIL],
          synopsis: 'Bram Ketteridge shows Wren that the Guild’s books and his cart counts disagree.',
          content: `Bram Ketteridge kept the harbor reeve’s office the way he kept his beard, badly and with great pride. He cleared a heap of mooring receipts from the one good chair and put the tithe book in her lap.

“Read me the last quarter,” he said.

Wren ran her finger down the column. Cray Landing had paid the Lamp Tithe in full, on the day it fell due, as it had every quarter since before she was born. Against each payment, in the neat green ink of the Guild’s clerks, someone had written the oil delivered: forty casks, forty casks, forty-two.

“That’s more than we burned last winter.”

“It’s more than came up the causeway,” said Bram. “I count the carts, girl. That’s the whole of my job. I’ve counted nine casks since midwinter.” He took the book back and shut it on his thumb. “So either I can’t count, or Isolde Marrable’s clerks can’t. And I’ve been reeve for twenty years, and nobody has ever paid me to be wrong.”

“Why tell me?”

“Because you’ll go and ask her, and I wouldn’t dare.” He nearly smiled. “You’ve your father’s stubbornness. It’s a terrible thing to see in the young.”`,
        },
        {
          kind: 'scene',
          title: 'The Guildhall Stair',
          status: 'draft',
          pov: 'Wren Halloway',
          storyDate: '412-03-16',
          location: 'Cray Landing',
          cast: ['Wren Halloway', 'Oswin Halloway', 'Isolde Marrable'],
          threads: [MISSING_OIL],
          synopsis: 'On the way up to the Guildmistress, Wren stops to talk with her father. Isolde Marrable sends her to Greywater.',
          notes: 'This scene has a planted mistake. See the page About this sample.',
          content: `The Guildhall smelled of wick-wax and wet wool. Wren climbed the long stair with the tithe figures folded in her sleeve, rehearsing what she would say to the Guildmistress.

She got as far as the turn. Oswin Halloway sat there on the window ledge, as he did most mornings, trimming a wick with the hooked knife he had carried for thirty years.

“You’ve been to see Ketteridge,” her father said, without looking up. “You’ve got his ink on your cuff.”

“The figures are wrong.”

“The figures are always wrong. It’s who they’re wrong for that matters.” He held the wick up to the grey light and squinted along it. “Go carefully with Marrable, Wren.”

At the top of the stair, the door stood open. Isolde Marrable did not ask her to sit. She read the figures through once, folded the paper in half, and then in half again.

“Greywater Light has been burning our oil for the better part of three hundred years,” she said. “If you want to know where the casks go, apprentice, go and count them there.” She held out the paper. “Take the ferry. I’m told the road is dark.”`,
        },
      ],
    },
    {
      kind: 'chapter',
      title: 'Greywater',
      synopsis: 'Wren and Tam cross the flats to the old lamp, and find what became of the oil.',
      children: [
        {
          kind: 'scene',
          title: 'Out on the Flats',
          status: 'draft',
          pov: 'Tam Corrow',
          storyDate: '412-03-18',
          location: 'The Saltmarch',
          cast: ['Tam Corrow', 'Wren Halloway'],
          threads: [WREN_AND_TAM],
          synopsis: 'Tam rows Wren out to Greywater Light at slack water.',
          notes: 'This scene has a planted mistake. See the page About this sample.',
          content: `Tam Corrow had rowed the flats for sixteen years, and he had never once liked them at slack water. The channels went quiet, the reeds stood up out of their own reflections, and it was hard to say which way anything lay.

Wren sat in the bow with her pole across her knees and the Tallow Key on its cord around her neck. She had not said ten words since the Landing.

“The Compact won’t thank me for this,” he said. “We do well out of a dark road.”

“I know you do.”

“I’m only saying.”

She turned to look at him then, her brown eyes narrowed against the wind, and he found that he had stopped rowing. She had always had a way of looking at a man as if he were a lamp she had been told to check.

“Hob would have your license,” she said.

“My father would have my skin first.” He bent to the oars again. Ahead of them, thin and black against the last of the light, Greywater Light stood up from the flats, and there was no flame at the top of it at all.`,
        },
        {
          kind: 'scene',
          title: 'The Lamp at Greywater',
          status: 'draft',
          pov: 'Wren Halloway',
          storyDate: '412-03-18',
          location: 'Greywater Light',
          cast: ['Wren Halloway'],
          threads: [MISSING_OIL],
          synopsis: 'Wren opens the oil room and finds three years of missing oil. Someone is at the sea door.',
          content: `The Tallow Key turned as if it had been oiled that morning, and that was the first wrong thing. Nobody had been posted at Greywater Light since the Long Flood.

Wren Halloway went up with her lantern shuttered. The stair smelled of the sea and, more faintly, of glasseel oil, thick enough to taste. On the oil-room door someone had chalked a count in a clerk’s tidy hand: *forty, forty, forty-two.*

The casks were all there. They stood in rows to the ceiling, every one with the Guild’s flame burned into its lid, every one full. She rapped on them with her knuckles, one after another, and none of them rang hollow. Three years of the Saltmarch’s light, and it had come no further than this.

Below her, the sea door banged. Then came a scrape of wood on stone, and a voice she did not know, saying something about the tide and the barges and how long they had.

She closed the shutter the rest of the way and stood very still in the dark, among all that unburned oil, and found that she was counting.`,
        },
        {
          kind: 'scene',
          title: 'Low Water',
          status: 'outline',
          pov: 'Tam Corrow',
          storyDate: '412-03-19',
          location: 'The Saltmarch',
          cast: ['Tam Corrow', 'Wren Halloway'],
          threads: [MISSING_OIL, WREN_AND_TAM],
          synopsis: 'Wren gets back to the boat before the tide turns. She tells Tam what she saw, and he tells her what the barges are for.',
          notes: 'Decide who the voice at the sea door is.',
        },
      ],
    },
  ],
};

export const SAMPLE_RELATIONSHIPS = [
  { from: 'Oswin Halloway', to: 'Wren Halloway', kind: 'parent of' },
  { from: 'Wren Halloway', to: 'Tam Corrow', kind: 'friend' },
  { from: 'Wren Halloway', to: 'The Lamplighters Guild', kind: 'member of', note: 'An apprentice since 403.' },
  { from: 'Oswin Halloway', to: 'The Lamplighters Guild', kind: 'member of' },
  { from: 'Isolde Marrable', to: 'The Lamplighters Guild', kind: 'leader of' },
  { from: 'Tam Corrow', to: 'The Ferry Compact', kind: 'member of' },
  { from: 'The Lamplighters Guild', to: 'The Ferry Compact', kind: 'rival' },
  { from: 'Cray Landing', to: 'The Saltmarch', kind: 'located in' },
  { from: 'Greywater Light', to: 'The Saltmarch', kind: 'located in' },
];

/** A file in the format of docs/IMPORT_FORMAT.md. */
export const SAMPLE_WORLD = {
  format: 'lorebook',
  version: 1,
  project: { meta: { eras: JSON.stringify([{ name: 'AC', offset: 0 }]) } },
  pages: SAMPLE_PAGES,
  books: [SAMPLE_BOOK],
  threads: SAMPLE_THREADS,
  relationships: SAMPLE_RELATIONSHIPS,
};
