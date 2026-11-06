import type { AuthorData } from '../types';

export const FANTASY: AuthorData[] = [
  {
    id: 'j-r-r-tolkien',
    name: 'J.R.R. Tolkien',
    genres: ['epic-fantasy', 'fantasy', 'classics'],
    knownFor: ['The Hobbit', 'The Lord of the Rings', 'The Silmarillion'],
    summary:
      "Tolkien writes as a chronicler of a real, ancient world, with a philologist's love of language and a deep sense of history behind each hill. The register moves from homely comedy among humble folk to high, saga-like grandeur. Songs, genealogies and old names give the story its depth, and journeys through closely observed landscape take as much space as battles.",
    traits: {
      narration:
        "Use a storyteller's omniscient third person, framed as a translated record of old events, staying with a small group of travelers and sometimes stepping back to give the long view of history.",
      sentences:
        "Shift register by class of speaker and gravity of moment: plain and cozy among rustics, then long, cadenced, archaic sentences, with inversions and and-linked clauses, for high matters.",
      diction:
        "Prefer old Germanic-rooted English words over Latin ones. Build your invented names with consistent languages behind them, and use archaic forms only where the speaker's dignity calls for them.",
      dialogue:
        "Let manner of speech mark rank and people: earthy talk from servants, formal and ceremonious language from kings, with courtesy, oaths and long councils where policy is debated.",
      description:
        "Describe terrain at walking pace: the fall of the land, weather, trees, stars and distances covered. Let places carry memory of what happened there long ago.",
      pacing:
        "Alternate long, restful journeys and hospitable stops with dread and sudden peril. Pause for songs, tales and lore. After the climax, let a long homecoming show what it cost.",
      signature:
        "Imply vast history behind the action through songs, ruins and half-told legends, without explaining them. Let the small and humble bear the fate of the great, in a mood of beauty passing away.",
      avoid:
        "Avoid modern slang, irony about the heroes, sexual explicitness and fast cutting. Never make a place a backdrop without a past.",
    },
  },
  {
    id: 'george-r-r-martin',
    name: 'George R.R. Martin',
    genres: ['epic-fantasy', 'fantasy'],
    knownFor: ['A Game of Thrones', 'A Clash of Kings', 'A Storm of Swords'],
    summary:
      "Martin writes epic fantasy as dynastic history, in rotating close third chapters where each viewpoint character is headlined and biased. Honorable people die for reasonable-seeming mistakes, and nobody is safe. Feasts, heraldry and sharp court talk build a world of concrete texture, while each character's voice colors the narration enough that the reader learns to distrust them all.",
    traits: {
      narration:
        "Give each chapter to one named viewpoint in tight third, soaked in that person's prejudices, age and vocabulary. Never leave that head during the chapter, and let other chapters contradict it.",
      sentences:
        "Write muscular, medieval-flavored prose, with lists and repeated phrases that become a character's private refrain. Shorten sentences hard at the end of a chapter for a blow.",
      diction:
        "Use earthy, sensual, faintly archaic language: rank, blood, wine, steel and titles. Mix courtly speech and crude soldier talk, and give houses their own mottos and sigils.",
      dialogue:
        "Write sharp courtly exchanges in which every courtesy is a threat. Let schemers and cynics trade wit, and let a character's habitual phrase become a mark of who they are.",
      description:
        "Catalog feasts dish by dish, heraldry, clothing, armor and the stench of war. Use food and arms to show wealth, season and status.",
      pacing:
        "Rotate viewpoints across a wide map, and end each chapter on a hook or a reversal. Kill or maim major figures unexpectedly, and let a marriage or truce be the setting for catastrophe.",
      signature:
        "Punish honorable choices and let the consequences of a single decision echo for books. Make a hated character sympathetic by giving them a viewpoint chapter.",
      avoid:
        "Avoid chosen-one certainty, clean wars, safe protagonists and tidy morals. A feudal world should not have modern manners.",
    },
  },
  {
    id: 'brandon-sanderson',
    name: 'Brandon Sanderson',
    genres: ['epic-fantasy', 'fantasy'],
    knownFor: ['Mistborn: The Final Empire', 'The Way of Kings', 'Elantris'],
    summary:
      "Sanderson writes clean, propulsive fantasy built around rule-based magic systems the reader can learn and then watch used cleverly. Characters work through problems step by step, and the climax is a huge cascade of revelations in which earlier details suddenly pay off. Prose is deliberately transparent, leaving focus on plot, on system and on protagonists overcoming their self-doubt.",
    traits: {
      narration:
        "Use a clear close third with several viewpoints, each with a defined inner struggle. Stay inside their reasoning, and explain what they are working out as they do it.",
      sentences:
        "Write plain, smooth, functional sentences with no ornament. Favor clarity at speed, especially during complex action where the reader must track exactly what happens.",
      diction:
        "Keep language modern-neutral, using invented terms for magic that are defined by practice and used consistently. Avoid archaic flourishes and heavy profanity, using invented mild oaths instead.",
      dialogue:
        "Write clean, earnest conversation with light banter. Let a sidekick supply jokes, and let mentors and allies test ideas about how the magic works and what is right to do.",
      description:
        "Describe how the magic feels and what it costs, with an unusual environment that has logical consequences for ecology and culture. Keep scenery brief and functional.",
      pacing:
        "Set rules early, then test them in escalating scenes. Build toward a long final sequence in which plot threads converge and revelations land one after another in rapid order.",
      signature:
        "Make magic work like a system with costs and limits, so the hero wins through a clever new use of rules the reader already knows. Plant facts early that, at the end, overturn everything.",
      avoid:
        "Avoid vague magic that solves problems unexplained, purple prose and grimly nihilistic endings. A climax's solution must never come from a rule the reader wasn't given.",
    },
  },
  {
    id: 'robert-jordan',
    name: 'Robert Jordan',
    genres: ['epic-fantasy', 'fantasy'],
    knownFor: ['The Eye of the World', 'The Great Hunt', 'The Shadow Rising'],
    summary:
      "Jordan writes immense, slow-unfolding epic fantasy with a very large cast, dense cultural detail and prophecy pressing on village youngsters who become world-shaking. Each nation has its own dress, customs and politics, described closely. Men and women constantly misread each other, in a running comedy, and the buildup across many books pays off in vast multi-threaded battles.",
    traits: {
      narration:
        "Use close third that rotates among many viewpoints, with each character certain that the others, particularly the opposite sex, are baffling. Let the narration share these misjudgments.",
      sentences:
        "Write long, descriptive, comfortably flowing sentences. Keep the rhythm steady and full, and let thoughts in italics interrupt to worry at a problem.",
      diction:
        "Use an invented world's titles and terms in quantity, consistently, with an old-fashioned tone. Give each nation its own oaths, courtesies and turns of phrase.",
      dialogue:
        "Write formal, status-conscious talk in which women's councils and courts maneuver, with sniping about who should obey whom. Let characters' habitual gestures, such as tugging at something, punctuate speech.",
      description:
        "Lavish attention on clothing, embroidery, furniture and customs of each new culture. Describe each arrival in a new land in detail, including who bows to whom.",
      pacing:
        "Take a slow, accumulating approach, with many subplots and political digressions. Have a small band leave home, split up, and regather only at huge climactic battles that end each volume.",
      signature:
        "Let prophecy pull reluctant farm-village friends into world-changing roles, and let history repeat in cycles, with each legend a garbled memory of what is happening now.",
      avoid:
        "Avoid spare prose, fast plots, small casts and thin worldbuilding. Don't let a new culture pass without detail on its dress and manners.",
    },
  },
  {
    id: 'robin-hobb',
    name: 'Robin Hobb',
    genres: ['epic-fantasy', 'fantasy'],
    knownFor: ["Assassin's Apprentice", 'Royal Assassin', 'Ship of Magic'],
    summary:
      "Hobb writes intimate fantasy from the inside of suffering, often as long, patient first-person memoirs of people used by their families and their duty. Plot moves slowly, because the interest is emotional consequence and loyalty tested until it hurts. Animal bonds and court politics are both felt deeply, and heroes pay dearly and repeatedly, without rescue.",
    traits: {
      narration:
        "Use a retrospective first-person memoir by a lonely, hurt narrator who looks back on their younger self with regret. Open chapters with a passage of history or legend written by the same hand.",
      sentences:
        "Write smooth, measured, reflective sentences, patient and close, that carry emotion by staying level. Let a long paragraph work through hurt feelings honestly.",
      diction:
        "Use simple, earnest, humane vocabulary, with practical words for stable work, healing, ships and crafts. Keep magic terms few and quiet.",
      dialogue:
        "Write painful conversations between people who love each other and cannot say it. Let the misunderstandings be believable, with old grievances and duty standing in the way.",
      description:
        "Describe daily work, animals, injuries and how a wound heals. Focus on the body's slow recovery and the texture of servant life in a keep.",
      pacing:
        "Take the slow road through years of childhood and apprenticeship, with setbacks that last chapters. Let long suffering build toward hard-earned moments of grace rather than victories.",
      signature:
        "Make the protagonist's loyalty the instrument of their ruin, with deep bonds to animals or friends that cost them everything. Make the reader ache through accumulated small betrayals.",
      avoid:
        "Avoid quick healing, quippy banter, power fantasies and easy reunions. Do not let suffering pass without consequences in later chapters.",
    },
  },
  {
    id: 'patrick-rothfuss',
    name: 'Patrick Rothfuss',
    genres: ['epic-fantasy', 'fantasy'],
    knownFor: ['The Name of the Wind', "The Wise Man's Fear"],
    summary:
      "Rothfuss writes lyrical, musical fantasy in which a legendary figure tells his own story to a recorder, deflating the myths told about him as he goes. Language itself is a pleasure, with rhythm, repetition and word games. Magic is a university subject, and a good deal of the book is about tuition, music, hunger and showing off.",
    traits: {
      narration:
        "Frame the tale with a quiet third person in the story's present, then let a gifted, boastful, self-aware man narrate his youth in first person, correcting the legends and hinting that he may not be wholly honest.",
      sentences:
        "Write lyrical, rhythmic sentences that are built for reading aloud, using triads, repetition and internal rhyme. Bring them back to a simple line after a long flight.",
      diction:
        "Love words: choose names, etymologies and precise terms for music and alchemy. Keep the tone warm and wry, with a storyteller's relish for a phrase.",
      dialogue:
        "Write quick, clever exchanges among students and between a shy flirting pair, full of wit, riddles and wordplay, with teachers who are eccentric but sharp.",
      description:
        "Describe music as emotion, hunger as physical fact and money as exact coin counts. Give small-scale, tactile attention to inns, workshops and university life.",
      pacing:
        "Move at a leisurely pace through episodes of apprenticeship, poverty and study, with stories nested inside the story. Use the framing present to hint at the disaster still to come.",
      signature:
        "Contrast the legend with the person who lived it, making the reader wonder how the gifted youth became the diminished figure telling the story. Treat language as literally powerful.",
      avoid:
        "Avoid quick plot beats, generic magic, flat prose and grim hopelessness. Do not rush past a good sentence or a song to get to the action.",
    },
  },
  {
    id: 'joe-abercrombie',
    name: 'Joe Abercrombie',
    genres: ['epic-fantasy', 'fantasy'],
    knownFor: ['The Blade Itself', 'Best Served Cold', 'The Heroes'],
    summary:
      "Abercrombie writes grimdark fantasy with a vicious sense of humor. Each viewpoint character has an unmistakable interior voice, and the narration in a chapter sounds like them, right down to the swearing. Heroes are vain or broken, torturers are the most likable people around, and battles are confused, filthy and ironic in their consequences.",
    traits: {
      narration:
        "Write very tight third person that speaks in the viewpoint character's slang and self-loathing, with thoughts in italics that contradict what they say out loud.",
      sentences:
        "Mix short, punchy lines and fragments with longer comic runs. Let a repeated refrain close scenes, and end chapters with a bitter punchline.",
      diction:
        "Use contemporary, profane, British-flavored language in a low fantasy setting, with no archaic flourishes. Keep the words earthy and bodily: mud, blood, snot, piss.",
      dialogue:
        "Write sardonic exchanges among killers who are tired of it, full of insults and gallows humor. Let a character's outward politeness clash with what their inner voice says.",
      description:
        "Show bodies: bad knees, missing teeth, what wounds do, how fear feels in the bowels. Portray battle as a mess viewed from within, with little sense of the whole.",
      pacing:
        "Let chapters end on a sharp reversal or dark joke, and let characters' hopes be undercut. Hand a fight off from viewpoint to viewpoint in a chain, as each dies.",
      signature:
        "Set up a heroic fantasy expectation, then break it cruelly and comically. Let people fail to change, and let the victor be the worst person in the room.",
      avoid:
        "Avoid noble speeches taken at face value, chosen ones, tidy redemption and solemn high fantasy language.",
    },
  },
  {
    id: 'terry-pratchett',
    name: 'Terry Pratchett',
    genres: ['fantasy', 'humor'],
    knownFor: ['Guards! Guards!', 'Small Gods', 'Going Postal'],
    summary:
      "Pratchett writes comic fantasy in which the jokes are a vehicle for humane, angry good sense about how people really behave. An all-seeing, amused narrator interrupts with footnotes, and a rich world grows through parody of ours. Beneath the wordplay, each book takes on a real subject such as belief, war or banking, and its people find their decency.",
    traits: {
      narration:
        "Use a wry, omniscient, conversational narrator who explains how the world works, generalizes about human nature, and breaks in with footnotes, then returns to a practical person's viewpoint.",
      sentences:
        "Build sentences toward a comic turn, setting up one meaning and landing on another. Vary long explanatory ones with short, dry, flat conclusions.",
      diction:
        "Use plain, clever English full of puns, literalized figures of speech and parodies of clichés. Keep the words ordinary, so that the idea rather than the vocabulary gets the laugh.",
      dialogue:
        "Write comic cross-talk in which sensible people struggle with fools, and bureaucrats, policemen and old women argue common sense. Give a person of few words the funniest line, delivered flat.",
      description:
        "Describe a place through its logic: how it's run, who is paid, what its smell means. Apply mundane economic and social reality to magical things, so that they feel lived-in.",
      pacing:
        "Follow several plot threads with chapter-free flow and scene breaks, with comic digressions that later turn out to matter. Let the climax be moral rather than magical, with the laughter stopping for a moment.",
      signature:
        "Use footnotes and asides to deliver the best jokes, and take a fantasy cliché literally until it reveals something true about people. Beneath the comedy, let real anger at cruelty show.",
      avoid:
        "Avoid random zaniness, sneering and jokes at the expense of the powerless. Comedy should never excuse a character's cruelty or skip a moral point.",
    },
  },
  {
    id: 'neil-gaiman',
    name: 'Neil Gaiman',
    genres: ['fantasy', 'horror'],
    knownFor: ['American Gods', 'Neverwhere', 'Coraline'],
    summary:
      "Gaiman writes modern fairy tales in a soft, clear, storytelling voice: myths and gods turn up in motels and on the Underground, and the strange is reported calmly. Simple words and bedtime rhythms lull the reader, and then something dark and cold appears. Dry English humor and a love of old stories make the wonder feel familiar.",
    traits: {
      narration:
        "Use an intimate storyteller's voice that seems to be telling you this over a fire, reporting uncanny events without surprise. Move between a quiet modern outsider's view and a teller's overview.",
      sentences:
        "Write simple, rhythmic, well-weighted sentences, as if for reading aloud. Use parallel phrases and a gentle cadence, and end with an unexpectedly chilling plain statement.",
      diction:
        "Use plain, soft, slightly old-fashioned words, drawn from folk tales and nursery rhymes. Mix them with dry modern English remarks and ordinary brand names.",
      dialogue:
        "Write understated conversations in which uncanny beings are polite, shabby and a bit tired. Let menace come in the form of courtesy or a mild joke.",
      description:
        "Give the mundane a slight wrongness: a shop you hadn't noticed, an extra door, a figure in a shabby suit. Use a few specific sensory details, and leave the rest to imagination.",
      pacing:
        "Follow a quiet person into a hidden world in a dreamlike, episodic way, with myths told as separate interludes. Let the ending be bittersweet, with a return that isn't quite a return.",
      signature:
        "Bring old gods and folk tales into shabby modern places, and tell them in a bedtime voice that makes the horror feel gentle and thereby worse. Follow the rules of fairy tale: bargains and prices.",
      avoid:
        "Avoid heavy technical worldbuilding, epic battles described in detail, and elaborate magic systems. Don't explain the wonder; leave it where you found it.",
    },
  },
  {
    id: 'steven-erikson',
    name: 'Steven Erikson',
    genres: ['epic-fantasy', 'fantasy'],
    knownFor: ['Gardens of the Moon', 'Deadhouse Gates', 'Memories of Ice'],
    summary:
      "Erikson writes vast, dense military fantasy that drops the reader into the middle of ancient conflicts with no explanation. Ground-level soldiers and near-immortal powers share the same chapters, and history runs over hundreds of thousands of years. Philosophical passages on compassion and suffering sit among apocalyptic battles, and understanding comes only on re-reading.",
    traits: {
      narration:
        "Use many close third viewpoints, from infantry sappers to near-immortal powers, and start in the middle with no glossary. Trust the reader to piece things together over thousands of pages.",
      sentences:
        "Write dense, elevated, often long sentences, shifting into philosophical meditation mid-scene. Let soldiers' scenes turn short and comic for contrast.",
      diction:
        "Use anthropological and archaeological vocabulary, along with invented peoples, magics and titles, without explanation. Mix high rhetoric with soldier profanity.",
      dialogue:
        "Write squad-level banter that is funny and irreverent, then cut to oracular exchanges among ancient beings. Let characters discuss the morality of history at the edge of a battle.",
      description:
        "Build scenes on layers of ruined time: strata, bones, older civilizations under the current one. Show the logistics and horror of march, siege and atrocity.",
      pacing:
        "Weave numerous plotlines that converge in a massive multi-viewpoint climax, with magic on an apocalyptic scale. Open with no context, and let early mysteries pay off much later.",
      signature:
        "Stage a convergence in which dozens of plots collide at one site. Force the reader to witness a civilian tragedy, then insist on compassion as the only answer to it.",
      avoid:
        "Avoid hand-holding, clear-cut prophecies, simple moral maps and a single protagonist. Don't stop to explain the world to a newcomer.",
    },
  },
  {
    id: 'n-k-jemisin',
    name: 'N.K. Jemisin',
    genres: ['epic-fantasy', 'fantasy'],
    knownFor: ['The Fifth Season', 'The Obelisk Gate', 'The Hundred Thousand Kingdoms'],
    summary:
      "Jemisin writes bold fantasy in formally daring voices, including sections in second person, where the narrator's identity is itself a secret. Geology, caste and enslavement are worked out as a real system, and the prose is direct, angry and intimate. The world's cataclysm and a mother's grief are treated with the same seriousness, and the narrator talks back to the reader.",
    traits: {
      narration:
        "Experiment with narrative stance: use second-person present for a woman's life, with a narrator who has a stake in the telling and reveals who they are late on. Let the storyteller speak to you directly.",
      sentences:
        "Write fluid, conversational, sometimes fragmented sentences with a colloquial edge. Interrupt with direct address, and let a short plain line deliver the pain.",
      diction:
        "Use modern, unceremonious language alongside invented terms for social castes and geology. Avoid faux-medieval formality, and let geological words work as metaphors for grief and power.",
      dialogue:
        "Write blunt, guarded conversations marked by class and survival, where people test how much they can say. Allow bitter humor and contemporary rhythms of speech.",
      description:
        "Ground the setting in science: seismic and volcanic processes, ash, stores of food, how a community survives. Let bodies and labor make oppression physical.",
      pacing:
        "Braid several timelines that seem separate, and spring a reveal connecting them. Open with disaster, and reveal the world's real history in layers, through myth and institutional records.",
      signature:
        "Structure the world's magic around oppression, so that those with power are feared, enslaved and used. Let form be the plot twist, as the reader learns who has been speaking and why.",
      avoid:
        "Avoid chosen-one comfort, pseudo-medieval courtly fantasy and neutral narrators. Do not treat systems of oppression as mere backdrop or resolve them neatly.",
    },
  },
  {
    id: 'andrzej-sapkowski',
    name: 'Andrzej Sapkowski',
    genres: ['fantasy', 'epic-fantasy'],
    knownFor: ['The Last Wish', 'Blood of Elves', 'Sword of Destiny'],
    summary:
      "Sapkowski, read in English translation, writes fantasy built from folk tales turned sour: a monster hunter goes from job to job and finds that the people who hired him are often worse than the monsters. Dialogue is the showpiece, long and witty, full of insults and philosophy. Slavic folklore, cynical politics and comic everyday bargaining undercut the romance of the genre.",
    traits: {
      narration:
        "Use a dry, ironic third person following a professional outsider, with structural play: scenes reported later by witnesses or told by historians and songwriters who get it wrong.",
      sentences:
        "Write brisk, conversational narration that leaves most of the work to speech. Keep sentences clear, with sly understatement after a burst of violence.",
      diction:
        "Mix earthy peasant idiom, medical and alchemical terms and modern-sounding sarcasm. Let the vocabulary of commerce, guilds and fees intrude on heroic matters.",
      dialogue:
        "Let characters talk at great length in witty, bawdy, philosophical exchanges. Have the hero haggle about payment, quarrel with sorceresses, and take apart a king's excuses.",
      description:
        "Describe monsters by a professional's method and cost, and show villages and courts as grubby and venal. Give battles a quick and competent sketch.",
      pacing:
        "Build episodic tales that each twist a familiar fairy tale, then link them into a larger war. Let long talk build tension before a very short burst of swordplay.",
      signature:
        "Retell a known folk tale so that its monster turns out more human than the people who hired the hero. Show a neutral man's attempt to stay out of politics fail.",
      avoid:
        "Avoid clear heroes, solemn high-fantasy diction and generic monsters. Do not let the hero act nobly without complaining about the fee.",
    },
  },
  {
    id: 'jim-butcher',
    name: 'Jim Butcher',
    genres: ['fantasy', 'mystery', 'thriller'],
    knownFor: ['Storm Front', 'Grave Peril', 'Changes'],
    summary:
      "Butcher writes urban fantasy as a hardboiled detective series, with a smart-mouthed wizard for hire narrating the supernatural underside of modern Chicago. Everything gets worse at a steady rate, and the hero meets each new catastrophe with geek references, stubborn chivalry and escalating magical firepower. The books are fast, funny and increasingly high in stakes.",
    traits: {
      narration:
        "Use a wisecracking first-person private-eye voice from an overmatched wizard, who explains magic in plain terms and mocks himself as things fall apart.",
      sentences:
        "Write fast, colloquial sentences with sarcastic fragments. Close scenes on a one-liner or a grim twist, and keep rhythm close to spoken American English.",
      diction:
        "Use pop-culture references, tabletop gaming jokes and contemporary slang, alongside practical magical terms. Keep profanity mild and invented oaths comic.",
      dialogue:
        "Write banter under fire: taunting monsters, teasing friends, and tense bargains with faerie and vampire courts in which exact wording matters.",
      description:
        "Keep urban settings functional and quick, with cheap apartments and bad cars. Describe spells through what they cost and how they go wrong, and give monsters a quick, nasty hook.",
      pacing:
        "Compress the plot into a few frantic days, with a new attack every chapter and no sleep for the hero. Let scene and sequel alternate: action, then a decision on what to do next.",
      signature:
        "Use the detective formula with magic: a client, a body, several supernatural factions and a final big magical stand. Keep raising the stakes so that the hero's victory costs him something permanent.",
      avoid:
        "Avoid solemn epic-fantasy diction, a calm hero and easy victories. Do not let magic be free of a price or a mess.",
    },
  },
  {
    id: 'glen-cook',
    name: 'Glen Cook',
    genres: ['fantasy', 'epic-fantasy'],
    knownFor: ['The Black Company', 'Shadows Linger', 'The White Rose'],
    summary:
      "Cook writes fantasy from the ranks: a mercenary company's annalist records the war in a laconic, soldier's voice, in which sorcerers are distant terrors and the troops mostly want to get paid. The prose is compressed and elliptical, leaving huge events to be inferred. The moral lines are blurred, because the narrators work for the bad side and know it.",
    traits: {
      narration:
        "Use first person from the unit's record-keeper or medic, writing a dry official-unofficial chronicle, with little patience for grand causes and a soldier's narrow view.",
      sentences:
        "Write terse, clipped sentences and fragments in a rapid-fire rhythm. Skip connective tissue, cut transitions, and let the reader catch up from context.",
      diction:
        "Use plain grunt speech, nicknames rather than names, and a hard modern tone with no medieval flourishes. Keep magic terminology vague, as soldiers wouldn't know it.",
      dialogue:
        "Keep soldiers' talk short and needling, with long-running practical jokes and bickering wizards. Say almost nothing about feelings, and let loyalty show in insults.",
      description:
        "Describe only what a tired soldier notices: terrain for an ambush, the state of the rations, dead friends. Give sorcery in fleeting and terrifying glimpses.",
      pacing:
        "Move in rapid bursts from battle to battle, skipping months with a line, and leaving big moves unexplained. Let the betrayal and intrigue above them hit the ranks as sudden orders.",
      signature:
        "Tell epic events from the mud as an unsentimental company record. Let the narrators do terrible things for a paycheck and write them down without excuses.",
      avoid:
        "Avoid lush description, noble quests, explanations of the magic and a broad overview of the war. Don't let the record-keeper sound like a poet for long.",
    },
  },
  {
    id: 'guy-gavriel-kay',
    name: 'Guy Gavriel Kay',
    genres: ['fantasy', 'historical', 'literary'],
    knownFor: ['Tigana', 'The Lions of Al-Rassan', 'Under Heaven'],
    summary:
      "Kay writes elegiac historical fantasy, with invented worlds closely modeled on real cultures such as medieval Spain or Tang China and only a slight touch of magic. A graceful, omniscient narrator keeps stepping forward to reflect on how chance shapes lives and what later generations will remember. Sentences carry a sorrowful music, and endings are bittersweet.",
    traits: {
      narration:
        "Use a mournful, wise, omniscient narrator who dips into many lives and comments on them from a distance, sometimes telling you what a character could not know or how they will die.",
      sentences:
        "Write long, cadenced, formal sentences interrupted by sentence fragments for emphasis. Repeat a line later in the book as a refrain, and let paragraphs end on a quiet ache.",
      diction:
        "Use dignified, ceremonious, poetic vocabulary, with courtly and military terms suited to the period model. Stay away from the modern and from invented jargon.",
      dialogue:
        "Write witty, deliberate exchanges among rulers, poets and doctors who know their words will be remembered. Let courtesy carry longing and danger.",
      description:
        "Evoke a culture through its poetry, food, trade, gardens and art, drawing on research into the real period. Show beauty as already passing.",
      pacing:
        "Take time to develop a wide cast before a great historical turn sweeps them apart. Stop in the midst of a crisis to give a minor person's brief story, and follow with a long epilogue of aftermath.",
      signature:
        "Pause at a turning point to meditate on chance and what might have been. Give a tiny, chance event the power to change a dynasty, and let the narrator grieve for it.",
      avoid:
        "Avoid modern banter, large magic systems, quick action without reflection and clear victors. Do not end without the cost.",
    },
  },
  {
    id: 'scott-lynch',
    name: 'Scott Lynch',
    genres: ['fantasy'],
    knownFor: ['The Lies of Locke Lamora', 'Red Seas Under Red Skies', 'The Republic of Thieves'],
    summary:
      "Lynch writes fantasy heists full of baroque profanity, elaborate cons and exuberant worldbuilding, in a canal city rich in alchemy and gang politics. The structure alternates the present scam with interludes from the thieves' childhood training, and the fun of watching a clever plan turns abruptly into real grief when it goes wrong.",
    traits: {
      narration:
        "Use a theatrical, amused third person that loves its rogues, with interludes that step away to explain the city's history, or to show an earlier lesson that matters right now.",
      sentences:
        "Write lively, ornate sentences with comic rhythm, using elaborate comparisons. Let them turn sharp and bloody without warning.",
      diction:
        "Use extravagantly inventive swearing and thieves' cant, along with architecture, alchemy and fine-dining terms. Enjoy a long list of invented and absurd delicacies.",
      dialogue:
        "Write fast, profane, affectionate banter within a gang of con artists, and elaborate role-playing patter when they deceive a mark. Let insult be the language of love.",
      description:
        "Lavish detail on a fantastical city's glass towers, floating markets and bizarre foods, with a strong sense of how each class lives and steals.",
      pacing:
        "Alternate a present-day scheme with flashback interludes that reveal the method just before it is needed. Let the con go smoothly, then let an outside force turn it into a revenge story.",
      signature:
        "Withhold a piece of the plan, so that the reader sees the reversal the same way the mark does. Follow a gleeful heist with a shocking, genuinely painful loss.",
      avoid:
        "Avoid grim seriousness throughout, plain language and heroes who are honest. Don't let the plan succeed without the reader learning how they were fooled.",
    },
  },
  {
    id: 'china-mieville',
    name: 'China Miéville',
    genres: ['fantasy', 'horror', 'literary'],
    knownFor: ['Perdido Street Station', 'The Scar', 'The City & the City'],
    summary:
      "Miéville writes weird fiction with a dense, baroque vocabulary and an almost tactile delight in the monstrous. His cities are crowded, filthy, politically charged organisms, full of hybrid species, industrial waste and labor unrest. Genre shapes such as the detective story or the sea adventure are bent around an impossible central conceit, and the language is itself a large part of the strangeness.",
    traits: {
      narration:
        "Use a third or first person that is fascinated by the city and its systems, and that notices class and labor everywhere, staying with marginal scientists, dockers, reporters and misfits.",
      sentences:
        "Write long, densely packed sentences with rare words and strange compounds, sometimes switching to very short lines. Let the syntax grow knotted when the thing described resists description.",
      diction:
        "Reach for obscure, muscular words from biology, architecture and engineering, and use invented compounds that feel industrial. Let political vocabulary sit beside the grotesque without embarrassment.",
      dialogue:
        "Give each species and class its own distinct way of speaking, including dialects written by ear. Let union arguments and street slang coexist with impossible creatures.",
      description:
        "Linger on urban decay, rail lines, slag, flesh grafted to machinery and creatures that defy category. Describe the monstrous as a naturalist would, with too much accurate detail.",
      pacing:
        "Spend a long time building a place and its factions, then let a bizarre threat tear through them. Finish with a morally bitter resolution rather than a clean victory.",
      signature:
        "Build the plot on one impossible rule of how a city or a language works, and follow its consequences through politics and daily life. Let a monster's biology be more inventive than anyone expects.",
      avoid:
        "Avoid pastoral medieval settings, elves and kings, simple vocabulary and tidy moral victories. Do not treat the setting as a backdrop with no economy.",
    },
  },
  {
    id: 'susanna-clarke',
    name: 'Susanna Clarke',
    genres: ['fantasy', 'historical', 'literary', 'humor'],
    knownFor: ['Jonathan Strange & Mr Norrell', 'The Ladies of Grace Adieu', 'Piranesi'],
    summary:
      "Clarke writes historical fantasy in a perfectly judged imitation of early nineteenth-century English prose, dry and ironic as if the author had read Austen and old folklore in equal measure. Long scholarly footnotes tell whole invented legends and argue with the main text. Magic is treated as an academic discipline with quarrelsome practitioners, until something truly uncanny and cold breaks through.",
    traits: {
      narration:
        "Use an urbane, amused nineteenth-century narrator with opinions about everyone, who reports wonders in the tone of a society historian and gently mocks learned men.",
      sentences:
        "Write balanced, leisurely Regency sentences with dry, understated closes. Use period spelling and grammar lightly and consistently, and let a comic sentence take its time.",
      diction:
        "Use the polite, slightly antique English of the period, along with invented scholarly titles and a faint folk-tale strangeness in the names of old magical things.",
      dialogue:
        "Write mannered conversations in which pride and vanity hide behind civility. Let fussy scholars and fashionable idlers talk past each other, and let the uncanny beings speak with chilling courtesy.",
      description:
        "Describe rooms, roads and society with a satirist's light touch. Set against this a few very strange images of cold country and silent roads, in plain, unsettling words.",
      pacing:
        "Unfold slowly, as a long history would, with room for anecdotes and scholarly quarrels. Let dread gather quietly under the comedy of manners and arrive late.",
      signature:
        "Add extensive footnotes that cite invented histories and tell complete stories, often more interesting than the plot. Set dry social comedy against old, amoral fairy magic that does not care about manners.",
      avoid:
        "Avoid modern idiom, system-like magic with tidy rules, fast action and a breathless tone. Do not explain the uncanny in the terms of the scholars who study it.",
    },
  },
  {
    id: 'naomi-novik',
    name: 'Naomi Novik',
    genres: ['fantasy', 'historical', 'young-adult'],
    knownFor: ['His Majesty\'s Dragon', 'Uprooted', 'A Deadly Education'],
    summary:
      "Novik adapts her voice to her premise with unusual skill: Napoleonic-era naval adventure in a polite period register, Eastern European fairy tale in a brisk first person, and a sardonic magical-school narrator who explains the rules at length. Common to them all is careful thinking about how magic or dragons would really change a society, along with close, loyal bonds.",
    traits: {
      narration:
        "Pick a voice that suits the premise and keep to it: a courteous close third for a period officer, or a sharp first-person young woman who explains exactly how her world can kill her.",
      sentences:
        "Write clean, well-made sentences suited to the register. Let first-person narrators run long in exasperated digressions, and keep the period voice measured.",
      diction:
        "Match the world's vocabulary closely, whether period naval terms or a village's fairy-tale speech. For modern-voiced narrators, allow sarcasm and blunt complaints about risk and resources.",
      dialogue:
        "Write warm, wry exchanges between unlikely partners, with bickering, courtesy and loyalty in the same breath. Let a nonhuman partner ask naive questions that expose human customs.",
      description:
        "Work out the practical consequences of the fantasy: rations, logistics, how a dragon is carried on a ship, how a magic school is engineered to fail. Use folk-tale imagery for anything truly old.",
      pacing:
        "Build through a chain of practical problems solved with stubbornness and cleverness, and widen the plot from one bond to the fate of a nation or a whole system.",
      signature:
        "Drop one fantastic element into a carefully researched or rule-bound society, then follow what changes. Center a devoted partnership that outsiders do not understand.",
      avoid:
        "Avoid hand-waved logistics, generic quest plots, and a modern voice in a period setting. Do not let the fantastic element leave the rest of society unchanged.",
    },
  },
  {
    id: 'mervyn-peake',
    name: 'Mervyn Peake',
    genres: ['fantasy', 'gothic', 'literary', 'classics'],
    knownFor: ['Titus Groan', 'Gormenghast', 'Titus Alone'],
    summary:
      "Peake writes grotesque, painterly gothic fantasy with no magic at all: just a vast crumbling castle, ruled by ritual nobody remembers the reason for. His characters are caricatures drawn by an illustrator's eye, with extravagant bodies and names. The prose is thick, slow and sumptuous, and an ambitious kitchen boy's rise through this stagnant world supplies the dread.",
    traits: {
      narration:
        "Use a grand, unhurried omniscient narrator that wanders through a huge building and into the minds of its grotesque inhabitants, treating each with equal pictorial attention.",
      sentences:
        "Write long, heavily cadenced sentences with piled-up adjectives and painterly clauses, slow and deliberate. Let a paragraph build like a canvas being filled.",
      diction:
        "Use a rich, sonorous, slightly archaic vocabulary of stone, moss, rust and ritual. Coin comically apt, Dickensian names for people that suggest their bodies or habits.",
      dialogue:
        "Write theatrical, stylized speech, with each character locked into their own absurd manner of talking. Let two people converse without ever really hearing each other.",
      description:
        "Describe architecture, light, shadow and bodies with a painter's obsession, down to knobbed joints and stained walls. Make the setting so overwhelming that it functions as the true protagonist.",
      pacing:
        "Move very slowly, with long set pieces of ceremony, and let tiny shifts in routine feel seismic. Let an outsider's patient ambition act as a slow-burning fuse.",
      signature:
        "Bury a whole society under meaningless ritual, and let its grotesque cast play out their obsessions inside a vast stone maze. Replace magic with sheer strangeness of place.",
      avoid:
        "Avoid magic systems, swift plots, sleek modern prose and quest structures. Do not hurry past a chance to describe a room.",
    },
  },
  {
    id: 'david-eddings',
    name: 'David Eddings',
    genres: ['fantasy', 'epic-fantasy', 'humor'],
    knownFor: ['Pawn of Prophecy', 'Magician\'s Gambit', 'The Diamond Throne'],
    summary:
      "Eddings writes comfortable, chatty quest fantasy carried by the banter of a party of old friends. A farm boy with a hidden destiny travels with bickering immortals, a wisecracking thief and a stoic knight, while each nation stands for one easily remembered trait. The plot is unashamedly a prophecy being fulfilled, and the fun is in the company and the running jokes.",
    traits: {
      narration:
        "Use an easygoing third person near a naive young hero who constantly asks questions and is teased for it, with a mild, humorous tone and no real sense of doom.",
      sentences:
        "Write relaxed, plain sentences with conversational rhythm and quick transitions. Let scenes open and close on a small joke.",
      diction:
        "Use simple, slightly formal fantasy language, without any difficult invented vocabulary. Let each nation's speech have a light, recognizable mannerism.",
      dialogue:
        "Make affectionate bickering the main attraction: long-running insults between family members who have known each other for ages, and a roguish companion's jokes. Let dialogue deliver nearly all the world's explanation.",
      description:
        "Give each new country a quick sketch of its climate, clothes and national character, then move on. Keep travel light, and treat it as a chance for conversation.",
      pacing:
        "Follow a clear itinerary through one kingdom after another, gathering companions and meeting a local problem in each. Let prophecy guarantee progress, and save the great confrontation for the last volume.",
      signature:
        "Build a found family out of squabbling companions, with running gags that return across volumes, and let a shy hero grow up while being teased. Deliver reassuring, cozy epic adventure.",
      avoid:
        "Avoid grim realism, moral ambiguity, sexual explicitness and complex prose. Do not let a scene go by without warmth or a joke among the party.",
    },
  },
  {
    id: 'madeline-miller',
    name: 'Madeline Miller',
    genres: ['fantasy', 'historical', 'literary'],
    knownFor: ['The Song of Achilles', 'Circe', 'Galatea'],
    summary:
      "Miller retells Greek myth from the inside, through marginal or overlooked figures whose voices feel startlingly intimate. Her first-person prose is clear, lyric and restrained, and it brings the gods down to the scale of a single longing person. The ancient outcome is known, so the tension is in how love and pride will walk toward it.",
    traits: {
      narration:
        "Use an intimate, retrospective first person from a figure the old stories left in the background, whose quiet voice sees heroes and gods at human range.",
      sentences:
        "Write clean, lyrical, balanced sentences that lean on simple images, with a poet's economy. Let a short line carry the emotional weight at a paragraph's end.",
      diction:
        "Use plain, timeless words, with sensory terms for herbs, looms, sea and bodies. Echo epic epithets occasionally, but keep the language free of archaism.",
      dialogue:
        "Keep exchanges sparse and charged. Let the powerful speak with careless cruelty, and let lovers talk simply, with whole histories behind each small remark.",
      description:
        "Describe daily work, such as weaving, herb gathering or caring for animals, with quiet attention. Show divine power through small physical wrongness rather than spectacle.",
      pacing:
        "Move in a slow arc across years, using the known myth as fate. Allow calm chapters of craft or love before the old story arrives, as the reader has always known it would.",
      signature:
        "Tell a famous myth from the view of someone it overlooked, and let foreknowledge of the end be the ache. Make the mortal small things outweigh the glory of the gods.",
      avoid:
        "Avoid epic bombast, modern slang, battles as spectacle and comic asides. Do not deflate the myth with irony; deepen it by getting close.",
    },
  },
  {
    id: 'robert-e-howard',
    name: 'Robert E. Howard',
    genres: ['fantasy', 'classics'],
    knownFor: ['The People of the Black Circle', 'Red Nails', 'The Hour of the Dragon'],
    summary:
      "Howard writes pounding, headlong sword-and-sorcery in which a barbarian's raw vitality meets decadent, sorcerous civilizations. The prose has a hammering rhythm, full of strong verbs and physical color, and its violence is immediate. Short tales rush from a tense opening to a frenzied fight with something ancient and unclean, with the sense of a lost age of the world behind them.",
    traits: {
      narration:
        "Use a driving, muscular third person that follows a physically commanding outsider, with admiration for his instincts and contempt for soft, scheming city folk.",
      sentences:
        "Write rhythmic, hard-hitting sentences with strong verbs and vigorous cadence. Let the pace become almost breathless in a fight, as clause drives into clause.",
      diction:
        "Use bold, colorful, pulp-grand vocabulary, heavy with blood, steel, shadow and crimson. Invent names that sound like lost peoples from a half-remembered ancient world.",
      dialogue:
        "Keep the hero's speech blunt and contemptuous of convention. Let sorcerers and schemers speak in florid threats, which he answers with few words and his sword.",
      description:
        "Paint ruined cities, jungle heat, torchlight and strange altars in lurid, saturated strokes. Show fighting in precise, savage physical motion.",
      pacing:
        "Open under immediate threat and move at top speed, with each scene escalating to the next clash. Let the climax be a desperate physical fight with something ancient, and end quickly afterward.",
      signature:
        "Set barbarian vigor against civilization's decay, and pit steel and will against ancient, inhuman sorcery. Frame everything as a fragment of a vast forgotten history.",
      avoid:
        "Avoid introspection, irony about the hero, slow politics and gentle resolutions. Do not let a hero's strength be subtle or a fight be vague.",
    },
  },
  {
    id: 'mark-lawrence',
    name: 'Mark Lawrence',
    genres: ['fantasy', 'epic-fantasy'],
    knownFor: ['Prince of Thorns', 'Prince of Fools', 'Red Sister'],
    summary:
      "Lawrence writes dark fantasy in terse, stylish first person, most notoriously through a teenage prince who narrates atrocity with bored, philosophical swagger. The narrators are witty, quotable and morally compromised, and the charm of the voice implicates the reader. Worlds that look medieval hide buried traces of a lost technological past, and timelines interleave to withhold what really happened.",
    traits: {
      narration:
        "Narrate in first person through a clever, amoral or self-serving protagonist who speaks with total confidence and treats the reader as a fellow cynic.",
      sentences:
        "Write short, polished, aphoristic sentences. Let a paragraph end on a dry, cruel remark, and keep the prose stripped down even at moments of horror.",
      diction:
        "Use spare, modern-sounding language with a sharp edge. Let learning show in a stray classical reference, and keep invented terms few.",
      dialogue:
        "Write clipped, menacing banter among killers. Let the narrator win arguments by saying the most shocking true thing in the room.",
      description:
        "Give just enough physical detail to be sharp, such as an old burn or a broken tooth. Slip in unexplained relics that let the reader work out that this world has a buried past.",
      pacing:
        "Cut between the present action and a past timeline that keeps withholding the key event. End chapters on a reversal, a joke or an act of shocking decisiveness.",
      signature:
        "Let a charming, intelligent voice make the reader like someone who does unforgivable things. Slowly reveal that the fantasy world stands on the ruins of a technological civilization.",
      avoid:
        "Avoid lengthy description, noble heroes, apologies from the narrator and moralizing commentary. Don't soften the narrator to make him easier to forgive.",
    },
  },
];
