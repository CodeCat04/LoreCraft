import type { AuthorData } from '../types';

export const HORROR: AuthorData[] = [
  {
    id: 'stephen-king',
    name: 'Stephen King',
    genres: ['horror', 'thriller'],
    knownFor: ['The Shining', 'It', 'Misery'],
    summary:
      "King writes horror from inside ordinary American lives: working people with brand-name cupboards, bad habits and town histories. A loose, colloquial voice spends hundreds of pages making you love a small community before something tears it apart. Fear grows from character and domestic detail, and interior thoughts break into the narration in parentheses, like a second voice the person can't shut up.",
    traits: {
      narration:
        "Use a chatty close third, or first person, that moves through a whole town's heads and takes on each person's idiom. Let parenthetical thoughts interrupt the sentence, as if the mind were talking over itself.",
      sentences:
        "Write loose, conversational sentences that run on in spoken rhythm and then stop short. Italicize intrusive thoughts and repeat a phrase until it becomes a dread refrain.",
      diction:
        "Use plain American vernacular with profanity, regional speech and exact brand names for beer, cars and groceries. Coin private family slang that recurs through the book.",
      dialogue:
        "Write salty, overlapping small-town talk, with long-married couples and old friends ribbing each other. Let people joke while frightened, and give each a verbal habit.",
      description:
        "Build the ordinary in loving detail, the kitchen, the job, the local history, then introduce one wrong thing. Describe bodily horror frankly, using household comparisons.",
      pacing:
        "Take a long, patient lead-in with backstory digressions and a foreshadowing narrator who says what is coming. Let dread accumulate, then crash into an extended, chaotic climax.",
      signature:
        "Root the supernatural in real private fears such as addiction, grief and failing as a parent. Tell the reader offhandedly that a likable character will soon be dead, then keep them company until it happens.",
      avoid:
        "Avoid elegant restraint, generic settings, characters with no history and monsters without a human parallel. Do not rush past the everyday to reach the scare.",
    },
  },
  {
    id: 'h-p-lovecraft',
    name: 'H.P. Lovecraft',
    genres: ['horror', 'gothic', 'classics'],
    knownFor: ['The Call of Cthulhu', 'At the Mountains of Madness', 'The Shadow over Innsmouth'],
    summary:
      "Lovecraft writes cosmic horror as a scholar's confession: an educated narrator pieces together documents and rumors until he grasps something that makes human life meaningless. The prose is archaic, adjective-heavy and deliberately excessive, and it refuses to fully describe what it fears. Terror comes from scale, deep time and the failure of reason itself.",
    traits: {
      narration:
        "Use a retrospective first person from a shaken antiquarian or scientist, writing a warning after the fact, and doubting his own sanity from the first line.",
      sentences:
        "Write long, periodic, heavily subordinated sentences in an antique style, building through accumulating clauses to a final, italic-worthy revelation at the end of a paragraph or story.",
      diction:
        "Use archaic and Latinate vocabulary, with words for decay, antiquity and non-Euclidean wrongness. Combine geological and anthropological terms with adjectives such as eldritch or blasphemous.",
      dialogue:
        "Use very little direct speech. Render it through reported testimony, old letters, or the broken dialect of a frightened local, rather than scenes of conversation.",
      description:
        "Describe through what cannot be described: impossible angles, wrong proportions and colors with no name. Prefer the ruins, carvings and geology of inhuman age, and suggest more than you show.",
      pacing:
        "Build as an investigation of clippings, diaries and hearsay, with each document closing off a rational explanation. Save the true horror for the final lines, often stated in a single flat reveal.",
      signature:
        "Show a scholar learning a truth about deep time that dissolves any human significance. Make knowledge itself the danger, and leave the narrator ruined by what he has understood.",
      avoid:
        "Avoid heroic victories over the threat, fully visible monsters, modern casual speech and comic relief. The narrator must never recover or defeat it.",
    },
  },
  {
    id: 'edgar-allan-poe',
    name: 'Edgar Allan Poe',
    genres: ['horror', 'gothic', 'classics', 'mystery'],
    knownFor: ['The Tell-Tale Heart', 'The Fall of the House of Usher', 'The Murders in the Rue Morgue'],
    summary:
      "Poe writes short, feverish tales through narrators who insist they are sane while proving the opposite. Each story is designed for a single overwhelming effect, and every detail serves that mood. The language is formal, musical and obsessive, full of repetition and exclamation, so that the prose feels like the racing of a disordered mind.",
    traits: {
      narration:
        "Use an excitable first-person confessor who addresses the reader directly, protests his reason, and condemns himself with each attempt at explaining.",
      sentences:
        "Write formal, rhythmic nineteenth-century sentences broken by dashes, exclamations and repeated words. Let the cadence quicken as the narrator's control slips.",
      diction:
        "Use ornate, Latinate, slightly archaic vocabulary, heavy with gloom, melancholy and terror. Mix pseudo-scientific terms and classical allusions with sudden cries.",
      dialogue:
        "Use dialogue rarely and theatrically. Let a companion be a silent witness, and let speech be formal and mannered, carrying more dread than information.",
      description:
        "Fix on a single obsessive object or sound, such as an eye, a beat or a tolling, and let it grow. Use enclosed, decaying rooms, heavy drapes, vaults and dim light.",
      pacing:
        "Keep it short, with every element aimed at one final effect. Tighten steadily to a frenzied climax, stopping almost at once when the horror lands.",
      signature:
        "Let an unreliable, guilt-ridden mind hear or see what may not be there, and let confession erupt from the narrator's own nerves. Use repetition like a tolling bell.",
      avoid:
        "Avoid digressions, casual modern voice, cheerful subplots and calm explanations. Do not dilute the single mood with anything that doesn't serve it.",
    },
  },
  {
    id: 'shirley-jackson',
    name: 'Shirley Jackson',
    genres: ['horror', 'gothic', 'literary'],
    knownFor: ['The Haunting of Hill House', 'We Have Always Lived in the Castle', 'The Lottery'],
    summary:
      "Jackson writes quiet, unnerving domestic horror in cool, precise, slightly comic prose. Her fragile women inhabit houses and small towns that seem to want something from them, and you can't tell whether the threat is outside or in the mind. Politeness and social rituals become the instruments of cruelty, and the story often ends on a calm that is worse than a scream.",
    traits: {
      narration:
        "Use a close third or first person that slips, without signaling, from a lonely woman's reasonable-seeming thoughts into delusion, so the reader cannot say when she stopped being reliable.",
      sentences:
        "Write clean, poised, conversational sentences with a dry, faintly mocking finish. Build a single long, formal sentence that seems quite calm, yet feels subtly off.",
      diction:
        "Use ordinary domestic words, such as tea, gloves, neighbors and groceries, with an edge. Keep the register polite and slightly old-fashioned, and let no one raise their voice.",
      dialogue:
        "Write courteous small talk in which guests and neighbors are cruel while smiling. Let a companion's cheerful banter turn feverish, and let a refrain recur in strange places.",
      description:
        "Treat a house as a mind, its angles slightly wrong and its rooms taking notice. Describe everyday objects so that they gain menace, using exact and very simple words.",
      pacing:
        "Advance slowly through small social embarrassments and misplaced things, with ghostly events kept at the edge of possibility. End abruptly on an eerie serenity, without explanation.",
      signature:
        "Leave it undecided whether the terror is supernatural or psychological. Show a community's ordinary manners and rituals concealing an appetite for cruelty against one of its own.",
      avoid:
        "Avoid gore, explicit monsters, shouting and clear explanations. Don't let the narrator announce that she is afraid or mad.",
    },
  },
  {
    id: 'clive-barker',
    name: 'Clive Barker',
    genres: ['horror', 'fantasy'],
    knownFor: ['Books of Blood', 'The Hellbound Heart', 'Weaveworld'],
    summary:
      "Barker writes visceral, visionary horror in which flesh, pleasure and pain are intertwined, and in which monsters can be more alluring than the ordinary people fleeing them. His sensual, literary prose takes a painter's delight in transformation. Hidden worlds lie beneath dull English streets, and desire pulls people through the door.",
    traits: {
      narration:
        "Use an intimate third person that follows a dissatisfied person's secret desire into a forbidden realm, and sympathizes with what the reader expects to be monstrous.",
      sentences:
        "Write rich, muscular, rhythmic sentences that turn from graceful to shocking. Let a long, sensuous line finish in a brutal physical image.",
      diction:
        "Combine lush, elevated, almost liturgical vocabulary with blunt anatomical words. Keep the English setting drab, so the erotic and sacred language stands out.",
      dialogue:
        "Keep ordinary characters' speech plain and working-class, and let otherworldly beings speak in formal, seductive, priestly phrases that promise an experience beyond limits.",
      description:
        "Linger on the body remade: skin, sinew, wounds and ornament, described with an artist's delight. Render impossible architectures and hidden realms in painterly color.",
      pacing:
        "Open in shabby normality, let curiosity or lust open a door, and escalate to a grotesque transfiguration. Keep short stories tight, and let longer novels widen into mythic fantasy.",
      signature:
        "Make the monster an object of desire and offer it as liberation. Treat pain and ecstasy as the same door, and let a character choose to go through.",
      avoid:
        "Avoid coyness about the body, tidy moral punishment of the curious, and monsters as simple evil. Do not treat gore as mere shock; make it beautiful and strange.",
    },
  },
  {
    id: 'anne-rice',
    name: 'Anne Rice',
    genres: ['horror', 'gothic', 'fantasy'],
    knownFor: ['Interview with the Vampire', 'The Vampire Lestat', 'The Witching Hour'],
    summary:
      "Rice writes lush, sensual gothic novels from the point of view of the monsters themselves: eloquent, anguished immortals who narrate centuries of beauty and guilt. New Orleans and old Europe are rendered with an obsessive, velvet richness. The horror is less about fear than about longing, and the prose swoons along with its characters.",
    traits: {
      narration:
        "Let a brooding, cultured immortal narrate their own long history in the first person, in an intimate confession to a listener, with philosophical anguish at every turn.",
      sentences:
        "Write long, flowing, breathless sentences heavy with sensory clauses and emotional repetition. Build through and-linked rapture until feeling overflows.",
      diction:
        "Use ornate, romantic vocabulary about silk, candlelight, blood, music and damnation. Use period terms for dress, architecture and religion with a connoisseur's pleasure.",
      dialogue:
        "Write intense, intimate, operatic exchanges about the soul, loneliness and eternity between beautiful immortals who adore and betray each other.",
      description:
        "Saturate every scene with texture and color: brocade, marble, rotting opulence, hot nights, and the taste of blood as a sensual event. Linger on beauty and on the physical experience of it.",
      pacing:
        "Unfold over centuries through digressive life stories, nested tales and long reflective passages. Let plot arise from relationships, obsession and metaphysical searching rather than external threats.",
      signature:
        "Humanize the monster, making the reader fall in love with their guilt and longing. Treat immortality as both rapture and agony, in a historical setting rendered with lavish detail.",
      avoid:
        "Avoid clipped modern prose, jump scares, monster-hunting action and restrained feeling. Never make the vampire a simple villain, or the setting drab.",
    },
  },
  {
    id: 'mary-shelley',
    name: 'Mary Shelley',
    genres: ['gothic', 'horror', 'classics', 'classic-sf'],
    knownFor: ['Frankenstein', 'The Last Man', 'Mathilda'],
    summary:
      "Shelley writes grand, philosophical Romantic gothic, in nested first-person accounts that pass from letter-writer to scientist to the creature he has abandoned. Scientific ambition is shadowed by guilt, and sublime mountain and arctic landscapes reflect the soul's torment. Characters explain their anguish at length in eloquent, formal speeches, each giving the reader cause to reconsider the last.",
    traits: {
      narration:
        "Nest first-person accounts inside each other: an outer letter frames a confession, which contains another's self-defense. Let each narrator justify themselves with passion and partial blindness.",
      sentences:
        "Write long, balanced, formal Romantic sentences, with rhetorical apostrophes and exclamations of anguish, carefully structured and rising to pathos.",
      diction:
        "Use elevated early nineteenth-century vocabulary about natural philosophy, misery, benevolence and the sublime. Keep it dignified and impassioned, with classical education on display.",
      dialogue:
        "Render conversation as eloquent, extended speeches and pleas, in which even the monstrous argues like a philosopher and demands justice.",
      description:
        "Set inner states against sublime nature: glaciers, storms, lakes and desolate ice. Keep the laboratory and the science sketchy, focusing on awe and dread rather than method.",
      pacing:
        "Advance through a slow, doomed sequence of ambition, deed, flight and retribution, with long reflective pauses and pursuit over vast distances. Let the frame return at the end.",
      signature:
        "Make the scientist's overreach and failure of responsibility the true horror, and give the rejected creation the most moving voice in the book. Mirror maker and made until the reader cannot say who is the monster.",
      avoid:
        "Avoid technical detail on how the deed was done, modern colloquial speech, comic relief and simple villains. Do not deny the creature its argument.",
    },
  },
  {
    id: 'bram-stoker',
    name: 'Bram Stoker',
    genres: ['gothic', 'horror', 'classics'],
    knownFor: ['Dracula', 'The Lair of the White Worm', 'The Jewel of Seven Stars'],
    summary:
      "Stoker tells his great vampire story entirely through documents: journals, letters, ship's logs, telegrams and newspaper clippings assembled by the victims themselves. Modern Victorian technologies such as shorthand and the phonograph race an ancient evil across Europe. The effect is a slow, plausible dread, in which each writer knows less than the reader.",
    traits: {
      narration:
        "Tell the story only through dated journals, letters, logs and clippings by several hands, each writer limited to what they saw and misunderstanding it in their own way.",
      sentences:
        "Write earnest, correct Victorian sentences suited to the writer: precise for a young solicitor, warm for a young woman, breathless when a diary entry is scrawled under threat.",
      diction:
        "Use period English, with professional terms from law and medicine and an awareness of modern devices. Give dialect to sailors and local people, and a heavily foreign English to the learned expert.",
      dialogue:
        "Report conversations in the diaries as remembered speech, with courteous English friends and a foreign scholar who explains folklore in fractured, formal phrases.",
      description:
        "Note strange details with a traveler's factual care: train times, local customs, food and superstitions. Let the castle or the lonely coast grow sinister through a diarist's growing alarm.",
      pacing:
        "Begin with a slow, creeping captivity, move to attacks on the innocent at home, and end in a dated, documented chase across a continent. Let the gap between entries generate suspense.",
      signature:
        "Set ancient evil against modern record-keeping, with the heroes winning by collating their documents. Let the reader see the pattern long before any single writer can.",
      avoid:
        "Avoid an omniscient narrator, the monster's viewpoint, modern slang and early explanations. Don't let any entry know what a later entry reveals.",
    },
  },
  {
    id: 'daphne-du-maurier',
    name: 'Daphne du Maurier',
    genres: ['gothic', 'romance', 'thriller'],
    knownFor: ['Rebecca', 'Jamaica Inn', 'My Cousin Rachel'],
    summary:
      "Du Maurier writes romantic suspense with a poisonous undertow, in which an insecure narrator's jealousy and imagination do as much damage as any crime. A great house or the Cornish coast looms over the characters and shapes their fate. Her narrators are retrospective and haunted, and the love story turns slowly into something closer to a trap.",
    traits: {
      narration:
        "Use a retrospective first person from a self-doubting narrator who looks back from a diminished present, and whose suspicions distort everything we are told.",
      sentences:
        "Write smooth, elegant, slightly breathless English sentences that run on as anxiety gathers. Use long chains of imagined scenes, then a short, cold return to fact.",
      diction:
        "Use refined, mid-century English, attentive to class, manners and household management. Keep it restrained, so that a single word of envy or fear stands out.",
      dialogue:
        "Write polite conversations among the servants and the upper class, in which a remark about the past wounds. Let a superior servant or a charming guest menace by courtesy.",
      description:
        "Make the house and its grounds a living presence: overgrown drives, sea fog, cold rooms and a dead person's belongings. Let objects speak of someone absent.",
      pacing:
        "Take the first half slowly, through small humiliations and rising jealousy, then deliver a revelation that overturns who the reader thought was wronged. Let the end leave guilt unresolved.",
      signature:
        "Let an absent or dead person dominate the living through their possessions and reputation. Make the narrator imagine conversations that never took place, and leave the final truth in doubt.",
      avoid:
        "Avoid modern informal voice, confident heroines, straightforward happy romance and tidy proof. Don't let the reader be sure whether the beloved can be trusted.",
    },
  },
  {
    id: 'm-r-james',
    name: 'M.R. James',
    genres: ['horror', 'gothic', 'classics'],
    knownFor: ['Ghost Stories of an Antiquary', 'Oh, Whistle, and I\'ll Come to You, My Lad', 'Casting the Runes'],
    summary:
      "James writes short, scholarly English ghost stories in a dry, donnish voice. A bookish gentleman finds an old manuscript or object in a cathedral library or a country inn, and a small act of curiosity lets something in. Most of the story is genial antiquarian detail, so that the brief, tactile glimpse of the thing, when it arrives, is deeply unpleasant.",
    traits: {
      narration:
        "Use a mild, urbane, slightly evasive narrator who has the tale from a friend or a document, and who politely declines to tell the very worst of it.",
      sentences:
        "Write well-bred, balanced, late-Victorian sentences, with dry parentheses, then a sudden, plain, disquieting clause.",
      diction:
        "Use scholarly, churchy vocabulary: cathedral fittings, Latin tags, bibliographic terms and country-inn talk. Write invented documents with accurate period flavor.",
      dialogue:
        "Keep talk gentlemanly and commonplace among dons and clergy, with comic servants and rustics who know more than they say about the local trouble.",
      description:
        "Give exact details of a stall carving, a mezzotint or a parish record. Then show the horror in a brief, tactile, unwelcome way: hair, a wet touch, something behind the curtain.",
      pacing:
        "Spend most of the story on leisurely antiquarian research and small hints, then let one or two brief glimpses suffice. End quickly, with an understated report of the aftermath.",
      signature:
        "Let a harmless scholar's curiosity about an old object call down something malevolent. Keep the apparition half-seen, and touch the victim, rather than chase him.",
      avoid:
        "Avoid gore, long explanations, psychological subtext, modern settings and any romance. Do not raise the narrator's voice or linger on the ghost.",
    },
  },
  {
    id: 'charlotte-bronte',
    name: 'Charlotte Brontë',
    genres: ['gothic', 'romance', 'classics', 'literary'],
    knownFor: ['Jane Eyre', 'Villette', 'Shirley'],
    summary:
      "Brontë writes passionate first-person novels in which a plain, poor, intensely self-respecting woman tells her own story and addresses the reader directly. Gothic secrets and locked rooms are set against a fierce moral intelligence that refuses to be pitied. The prose moves between strict Victorian self-command and sudden storms of feeling, often mirrored in weather and landscape.",
    traits: {
      narration:
        "Tell the story in first person from an unglamorous, proud woman looking back. Turn to address the reader openly at moments of crisis, and judge herself as sternly as anyone.",
      sentences:
        "Write long, formal, passionate Victorian sentences with rhetorical balance and exclamations. Let self-control break into a rush of feeling, then be reined back in.",
      diction:
        "Use an educated, slightly biblical vocabulary of conscience, passion and duty, with exact words for moods. Use French phrases where the setting or a teacher calls for them.",
      dialogue:
        "Write verbal duels between a blunt, teasing older man of higher rank and a young woman who refuses to flatter him. Let frankness itself be the romance.",
      description:
        "Match landscape and weather to the inner state: moors, storms and cold schoolrooms. Describe faces closely, reading character from them with a moralist's eye, and insist on plainness.",
      pacing:
        "Follow the heroine's life in stages, from childhood humiliation through work and love to a test of principle. Let a gothic secret surface at the height of happiness, and force her to choose.",
      signature:
        "Make the heroine choose self-respect over the love she most wants, and only later receive love on equal terms. Let her speak her claim to equality in an outburst no one expected.",
      avoid:
        "Avoid pretty, passive heroines, irony at the expense of feeling and modern casual speech. Do not let the narrator pity herself or be rescued by beauty.",
    },
  },
  {
    id: 'emily-bronte',
    name: 'Emily Brontë',
    genres: ['gothic', 'romance', 'classics', 'literary'],
    knownFor: ['Wuthering Heights', 'Poems by Currer, Ellis, and Acton Bell'],
    summary:
      "Brontë's single novel tells a savage, elemental love story through two nested narrators, a baffled visitor and a shrewd, biased servant. Two houses and two generations are bound by obsession and revenge across wild moorland. No one in it is comfortably good, the narrative offers no moral guidance, and the violence of feeling has the force of weather.",
    traits: {
      narration:
        "Nest the story within limited outside narrators: a conventional newcomer writing down what a sharp-tongued servant tells him, with both of them misjudging what they saw.",
      sentences:
        "Write strong, plain, rhythmic nineteenth-century prose, with sudden speeches of extreme passion. Keep the servant's narration practical, so the wild material stands out by contrast.",
      diction:
        "Use blunt, elemental words of storm, heath, blood and hunger, and render the old servant's Yorkshire dialect by ear. Keep sentiment and polite vocabulary for those who are shown to be weak.",
      dialogue:
        "Let people curse, wound and declare impossible loves at the top of their lungs. Give the lovers speech that claims they are one being, and let no one speak softly about it.",
      description:
        "Use the two houses as moral poles: a storm-beaten farmhouse against a soft, carpeted grange. Render moor, wind and frost with hard exactness, as forces that shape character.",
      pacing:
        "Use a looping chronology through frames, moving across two generations. Let revenge play out slowly upon the children, and finish with a strange, hard-won quiet.",
      signature:
        "Present a love so destructive and absolute that it erases ordinary morality, and offer no narrator able to judge it. Let the second generation repeat and partly redeem the first.",
      avoid:
        "Avoid sweetened romance, likable leads, narrators with authority and a moral at the end. Do not soften cruelty or explain the passion.",
    },
  },
  {
    id: 'ira-levin',
    name: 'Ira Levin',
    genres: ['horror', 'thriller'],
    knownFor: ["Rosemary's Baby", 'The Stepford Wives', 'A Kiss Before Dying'],
    summary:
      "Levin writes lean, sly suspense in which something monstrous hides inside the ordinary comforts of modern life, such as a nice apartment, friendly neighbors or a good suburb. The clean, almost breezy prose stays close to one sensible woman who slowly suspects what everyone says is nonsense. The horror comes from social pressure and gaslighting, and it closes with a quiet, chilling irony.",
    traits: {
      narration:
        "Stay close in third person with a reasonable person whose small doubts everyone around her explains away, so that the reader shares her uncertainty about her own judgment.",
      sentences:
        "Write light, clean, efficient sentences with a brisk, almost cheerful rhythm. Keep the tone mild, so that a dreadful implication slips past inside a plain line.",
      diction:
        "Use contemporary domestic words, brand names, real addresses and everyday medical advice. Never use the vocabulary of horror; let the reader supply it.",
      dialogue:
        "Write chatty, friendly neighbors and caring husbands whose every reassurance tightens the trap. Let doctors and friends sound entirely sensible.",
      description:
        "Note redecorating, recipes, appointments and small kindnesses. Let one odd smell, a missing object or a too-tidy house be the only sign that anything is wrong.",
      pacing:
        "Keep it short and accelerating, as each explanation for a small oddity is plausible until they can't all be. Give the last pages a calm, ironic turn rather than a battle.",
      signature:
        "Turn domestic comfort into conspiracy, so the reader cannot tell if the heroine is paranoid until it is too late. Close on the horror accepted, not defeated.",
      avoid:
        "Avoid gothic atmosphere, gore, heavy foreshadowing and heroic rescue. Do not let the narration use a frightening word when a pleasant one will do.",
    },
  },
];
