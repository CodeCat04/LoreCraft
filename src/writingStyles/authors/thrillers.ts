import type { AuthorData } from '../types';

export const THRILLERS: AuthorData[] = [
  {
    id: 'tom-clancy',
    name: 'Tom Clancy',
    genres: ['technothriller', 'thriller', 'espionage'],
    knownFor: ['The Hunt for Red October', 'Red Storm Rising', 'Patriot Games'],
    summary:
      "Clancy explains how a system works before showing it fail, so technical exposition carries the suspense because the reader knows exactly what is at stake. Many separate threads, from a submarine sonar room to a Kremlin office to the White House, close on one crisis. The institutions and machines get as much attention as the people, and professionals doing a hard job well is the core pleasure.",
    traits: {
      narration:
        "Use a third person that moves freely among many viewpoints on all sides, from enlisted sonar operators to heads of state. Dip into each person's professional reasoning, and tell the reader things the characters do not yet know.",
      sentences:
        "Write plain, workmanlike sentences that stack factual clauses. Let explanation run long, then tighten to short declaratives once the hardware goes into action.",
      diction:
        "Use the exact names of weapons, ships, agencies and procedures, with acronyms and ranks explained once in passing. Keep the register sober, institutional and respectful of expertise.",
      dialogue:
        "Write shop talk between professionals: crisp reports, clipped radio procedure and dry service humor. In briefings, let a civilian or junior officer ask what the reader wants to know.",
      description:
        "Describe equipment and procedure in loving detail: how a sensor reads a signal, who must authorize what, how long a reload takes. Spend almost nothing on landscape or fashion.",
      pacing:
        "Open many threads far apart and cut between them in short scenes, tightening the intervals as they converge on one crisis. Long buildup is the point, so the climax can run nearly in real time.",
      signature:
        "Explain a system fully, then break it. Let the reader see the enemy's plan and the defenders' blind spot at once, so suspense comes from knowing more than anyone in the room.",
      avoid:
        "Avoid vague technology, lone heroes who win without an organization, and lyrical interiority. Never skip the procedure to reach the explosion.",
    },
  },
  {
    id: 'michael-crichton',
    name: 'Michael Crichton',
    genres: ['technothriller', 'thriller', 'hard-sf'],
    knownFor: ['Jurassic Park', 'The Andromeda Strain', 'Sphere'],
    summary:
      "Crichton writes science-driven thrillers disguised as documents: reports, charts and expert briefings lend a sheen of fact to an impossible premise. A team of specialists is brought somewhere isolated, a confident technical system fails in stages, and an intellectual skeptic explains why it was always going to. The prose is fast and clean, with characters defined mostly by their fields.",
    traits: {
      narration:
        "Use a brisk, journalistic third person with a report-like distance, moving among members of an expert team. Frame the story as a reconstruction of real events when it suits the premise.",
      sentences:
        "Write short, clear, functional sentences and short paragraphs that read like an excellent science article. Speed up to single-line paragraphs as the failure spreads.",
      diction:
        "Use real scientific and corporate vocabulary, explained simply for a lay reader. Keep the wording neutral and factual, so that speculation sounds like established science.",
      dialogue:
        "Use dialogue to teach: a specialist explains a concept while a colleague objects. Let an arrogant executive and a contrarian expert argue over whether the system is safe.",
      description:
        "Insert fake documents, printouts, graphs, data tables and memos as if they were evidence. Describe facilities and procedures precisely, and creatures or failures in clinical, observational terms.",
      pacing:
        "Spend the first third on briefing and arrival, with small anomalies in the data. Then let safeguards fail one after another, each cutting off an escape, until the story becomes a chase.",
      signature:
        "Make the villain hubris about a complex system: every safety has been considered, and a small unmodeled interaction defeats them. Open with an authoritative mock-nonfiction introduction.",
      avoid:
        "Avoid lyrical prose, deep psychology and supernatural explanations. A scare should always have a plausible technical cause, and characters should never stop thinking.",
    },
  },
  {
    id: 'clive-cussler',
    name: 'Clive Cussler',
    genres: ['thriller'],
    knownFor: ['Raise the Titanic!', 'Sahara', 'Inca Gold'],
    summary:
      "Cussler writes exuberant, globe-spanning maritime adventure: a historical prologue about a lost ship or treasure, then a modern hero who finds it while foiling a billionaire's scheme. The tone is confident and unabashedly larger than life. Salvage, classic cars, undersea engineering and impossible escapes are delivered with boyish relish and a straight face.",
    traits: {
      narration:
        "Use a wide-ranging third person that follows the square-jawed hero and sidekick, the villain's henchmen and doomed historical crews, with a storyteller's confidence in telling you how good everyone is.",
      sentences:
        "Write robust, energetic, moderately long sentences, heavy with adjectives and exact figures. Favor momentum and clarity over subtlety.",
      diction:
        "Use nautical, diving and engineering terms, plus the makes and years of vintage cars and aircraft. Enjoy superlatives, and describe beautiful people and fine meals with old-school gusto.",
      dialogue:
        "Write breezy banter between the unflappable hero and a wisecracking best friend, even under fire. Let villains make grand, unhurried speeches about their plans.",
      description:
        "Describe ships, wrecks, submersibles and collectible machines with specifications and histories. Paint ocean depths and exotic locations like a travel brochure with danger in it.",
      pacing:
        "Begin with a prologue set decades or centuries earlier, ending in a mysterious loss. Move between the salvage puzzle and escalating attacks, then finish with a giant set piece, often underwater.",
      signature:
        "Tie a historical mystery to a modern conspiracy, and let the hero escape by improvising with the machinery at hand. Reward the reader with the lost treasure and a vintage car at the end.",
      avoid:
        "Avoid moral gray areas, ambivalent heroes and bleak endings. Do not undercut the adventure with irony about its own improbability.",
    },
  },
  {
    id: 'frederick-forsyth',
    name: 'Frederick Forsyth',
    genres: ['thriller', 'espionage'],
    knownFor: ['The Day of the Jackal', 'The Odessa File', 'The Dogs of War'],
    summary:
      "Forsyth writes thrillers in the cool, factual voice of a foreign correspondent, so invention passes as reportage. He walks through how something illicit is actually done, from forging papers to ordering a custom weapon, step by patient step. Real history frames the fiction, and suspense survives even when the reader knows the historical outcome, because the interest lies in the method.",
    traits: {
      narration:
        "Use a detached, reportorial third person that states dates, offices and who knew what. Withhold the inner life of the operator, and report only what they do and what the investigators piece together.",
      sentences:
        "Write dry, measured, declarative sentences with few adjectives, like a long magazine investigation. Keep the same unhurried tone for an assassination as for a visit to a registry office.",
      diction:
        "Use the bureaucratic and tradecraft terms of police, intelligence services and arms dealers, stated plainly. Name real institutions and job titles. Avoid emotive words altogether.",
      dialogue:
        "Keep conversations brief and transactional: a craftsman quoting a price, a senior official giving an order in careful language. Let understatement show how dangerous people are.",
      description:
        "Detail the mechanics: which document unlocks which identity, how a tool is made, how a border is crossed, how much it costs. Treat cities as logistics rather than scenery.",
      pacing:
        "Follow a long operational plan through procurement and rehearsal, then cross-cut with a methodical investigator closing the distance. Keep tightening the gap until the final moment.",
      signature:
        "Show a how-to for something forbidden with procedural accuracy, and run a cat-and-mouse between two patient professionals who never meet until the end.",
      avoid:
        "Avoid gunfights, quips and flashy heroes, and any melodrama. The narrator should never sound excited or tell the reader how to feel.",
    },
  },
  {
    id: 'robert-ludlum',
    name: 'Robert Ludlum',
    genres: ['thriller', 'espionage'],
    knownFor: ['The Bourne Identity', 'The Matarese Circle', 'The Holcroft Covenant'],
    summary:
      "Ludlum writes breathless conspiracy thrillers in which a lone man learns that the institutions he trusted are compromised. The prose runs hot, with emphatic italics, urgent interior questions and sudden violence. Plots stack betrayal on betrayal across European cities, with secret organizations behind the visible powers, and nobody can be trusted until the last pages.",
    traits: {
      narration:
        "Use an urgent close third, tied to a hunted man whose thoughts break into the narration in italics, and shift to brief scenes among the conspirators who are tracking him.",
      sentences:
        "Write dramatic, punchy sentences with fragments, repetition and dashes. Let rhetorical questions and italicized thoughts pile up as panic builds, and do not fear melodrama.",
      diction:
        "Use intense, emphatic words: urgency, terror, fury, betrayal. Mix in intelligence and diplomatic titles, along with ominous names for secret groups and operations.",
      dialogue:
        "Write tense, interrupted exchanges in which people demand answers and hide things. Use whispered phone calls in code, and contacts who panic and hang up.",
      description:
        "Give quick, atmospheric impressions of rainy cities, hotel corridors, train stations and crowded streets, chosen as places to run from. Keep them moving and shadowed.",
      pacing:
        "Keep the chase relentless, with a reversal or betrayal in nearly every chapter. End chapters abruptly on a shock, and let each answer open a bigger conspiracy.",
      signature:
        "Give the hero one terrible uncertainty about his past or his allies, and let him use trained skills he cannot fully explain. Reveal that the true enemy sits inside the trusted institution.",
      avoid:
        "Avoid calm, leisure and domestic comfort. Do not let the hero rest or trust anyone for long, and do not stop for technical lectures.",
    },
  },
  {
    id: 'dan-brown',
    name: 'Dan Brown',
    genres: ['thriller', 'mystery'],
    knownFor: ['The Da Vinci Code', 'Angels & Demons', 'Inferno'],
    summary:
      "Brown writes puzzle-chase thrillers compressed into a day or two, with an expert guide hurrying from landmark to landmark solving codes. Very short chapters cut away at each moment of discovery, and long explanations of art history and symbols are delivered on the run. The pleasure lies in learning something surprising about a famous place while someone with a hidden motive closes in.",
    traits: {
      narration:
        "Use third person close to a learned academic hero, cutting between the hero, a pursuing killer, and a hidden mastermind whose identity is withheld for a final twist.",
      sentences:
        "Write simple, swift sentences, with one-line paragraphs for shocks and italics for sudden thoughts. Keep the grammar easy so that the reader races through.",
      diction:
        "Use accessible language, with art, religious and cryptographic terms defined at once. Present each historical claim with the confidence of a lecture hall.",
      dialogue:
        "Use dialogue as a guided tour: a mentor poses a riddle or a surprising fact, and a sharp companion asks questions and pushes back, solving the next step together.",
      description:
        "Introduce every landmark, artwork and institution with an authoritative mini-history and exact details. Describe people by their striking feature and credentials.",
      pacing:
        "Compress the plot into about a day, with chapters only a page or few long. End each on a cliffhanger or partial reveal, then cut away, and return only after another thread has moved.",
      signature:
        "Build the plot as a chain of codes hidden in real art and architecture, with each solution pointing to the next location. Cap it with a reveal that a trusted ally was the villain.",
      avoid:
        "Avoid slow interior chapters, ambiguous puzzles and quiet endings. A chapter should not end without a new question.",
    },
  },
  {
    id: 'john-grisham',
    name: 'John Grisham',
    genres: ['thriller'],
    knownFor: ['The Firm', 'A Time to Kill', 'The Pelican Brief'],
    summary:
      "Grisham writes legal thrillers in plain, easy, Southern-inflected storytelling, where an idealistic young lawyer runs up against firms, insurers or courts that are stronger and more corrupt. The law itself supplies the suspense: motions, deadlines, jury selection and billing practices are all explained simply. Small-town courthouses and big-city firms are drawn from inside the profession, with dry humor about lawyers.",
    traits: {
      narration:
        "Use an easygoing third person, sometimes first, near an underdog attorney, with a storyteller's asides about how the local bar and courthouse really operate.",
      sentences:
        "Write straightforward, conversational sentences, unshowy and quick to read. Let a plain summary carry weeks of legal maneuvering in a paragraph.",
      diction:
        "Use legal terms explained in everyday words, and the dry slang of courthouse regulars. Keep it plainspoken, with a slight Southern ease and little figurative language.",
      dialogue:
        "Write realistic lawyer talk: settlement haggling, sparring with a judge, partners making veiled threats over lunch. Let the courtroom cross-examination be the showpiece.",
      description:
        "Sketch offices, courthouses and diners with a few insider details, such as hours billed, what the partners drive, and who owes whom. Dwell on money and status rather than scenery.",
      pacing:
        "Start with a small case or a too-good job offer, and reveal the scale of the wrong by degrees. Build to a trial or a deadline, with a last-minute legal maneuver as the climax.",
      signature:
        "Turn procedure into plot: a filing deadline, a sealed document or a jury problem becomes the ticking bomb. Let the little guy win through knowledge of the rules, at a price.",
      avoid:
        "Avoid dense legalese, lyrical description and superhero lawyers. Do not let a case be won by a surprise that the rules would not allow.",
    },
  },
  {
    id: 'lee-child',
    name: 'Lee Child',
    genres: ['thriller'],
    knownFor: ['Killing Floor', 'One Shot', 'Die Trying'],
    summary:
      "Child writes lean, relentless thrillers around a drifter who arrives in a town, notices something wrong, and takes it apart. Clipped, deadpan prose turns thinking into action: the hero calculates angles, distances and odds in plain words before a fight lasts a few seconds. Suspense comes from questions planted early and answered slowly while the narration keeps an almost hypnotic beat.",
    traits: {
      narration:
        "Use a flat, observant voice in first person or close third, sticking tightly to one self-sufficient man who reads a room like a crime scene and states what he deduces.",
      sentences:
        "Write short declaratives and fragments, with repetition as rhythm. Use run-ons joined by and for moments of sustained movement, and one-word paragraphs for emphasis.",
      diction:
        "Use plain, concrete, American words, with exact figures for time, distance, caliber and body weight. Avoid adjectives that judge; report instead.",
      dialogue:
        "Keep exchanges terse and interrogative, with the hero asking simple questions and often answering with silence. Narrate the silence as a deliberate move in the conversation.",
      description:
        "Describe physical geometry and small inconsistencies: who stands where, how far the door is, what doesn't belong. Give people exact heights and weights, as a fighter would size them up.",
      pacing:
        "Plant a question in the first pages and refuse to answer it for chapters. Hold each fight back through long calculation, then finish it in a burst, and end chapters on a flat, ominous line.",
      signature:
        "Slow time before violence, walking through physics and anatomy step by step, as the hero plans exactly what happens next. Let him stay still for a long time, and then do one decisive thing.",
      avoid:
        "Avoid emotional speeches, ornate metaphor, romantic brooding and a hero who hesitates afterward. Do not explain feelings; describe what he does next.",
    },
  },
  {
    id: 'james-patterson',
    name: 'James Patterson',
    genres: ['thriller', 'crime'],
    knownFor: ['Along Came a Spider', 'Kiss the Girls', '1st to Die'],
    summary:
      "Patterson writes for maximum speed: extremely short chapters, simple sentences and constant cliffhangers. A first-person detective's warm home life alternates with third-person scenes in a killer's mind, which gives the reader dread the hero doesn't share. The method is pure propulsion, built to make stopping feel impossible.",
    traits: {
      narration:
        "Alternate a likable first-person investigator, with family warmth at home, against chilling third-person chapters inside the killer's head. Keep the switch abrupt and frequent.",
      sentences:
        "Write very short, plain sentences, with many one-line paragraphs. Use exclamations and fragments for shocks, and no sentence that needs a second reading.",
      diction:
        "Use simple, conversational, everyday words. Prefer the common word, and let strong verbs and blunt statements do the work without description or literary flourish.",
      dialogue:
        "Keep talk brief and natural: cops trading quick lines, kids teasing at the breakfast table, a taunting call from the killer. A line of dialogue often ends a chapter.",
      description:
        "Give one or two quick details and move on. Show a crime scene or a house just enough to orient the reader, and leave the rest out.",
      pacing:
        "Keep chapters to a couple of pages, each ending on a hook, reversal or threat. Cut constantly between hunter and hunted, and stack a final twist on top of the supposed ending.",
      signature:
        "Set the warmth of family dinners against sudden scenes of a predator at work, so that the reader always knows more than the hero, and let the killer address the detective personally.",
      avoid:
        "Avoid long paragraphs, scenery, digressions and subtle endings. If a passage does not make the reader turn the page, cut it.",
    },
  },
  {
    id: 'gillian-flynn',
    name: 'Gillian Flynn',
    genres: ['thriller', 'crime'],
    knownFor: ['Gone Girl', 'Sharp Objects', 'Dark Places'],
    summary:
      "Flynn writes psychological thrillers in acid, confiding first person, with damaged narrators whose honesty is itself a tactic. The voices are savagely funny about marriage, class, gender and small-town rot. Plots hinge on a reversal of who has been lying to the reader, and the nastiness of the ending is earned through intimacy rather than gore.",
    traits: {
      narration:
        "Use intimate first person from a sharp, resentful, self-aware narrator who confides in the reader and misleads them. Alternate voices or timelines so that accounts can contradict each other.",
      sentences:
        "Write quick, biting sentences with sudden crude turns. Mix long sardonic riffs with a short final blow, and use lists of grievances for comic effect.",
      diction:
        "Use contemporary, profane, pop-culture-aware language, and specific brand-name class markers. Let the vocabulary be mean and exact about bodies, money and manners.",
      dialogue:
        "Write barbed conversations in which spouses, mothers and old friends wound each other with casual remarks. Let what is performed for others differ sharply from what the narrator thinks.",
      description:
        "Describe decaying small towns, recession-hit suburbs and bodies in an unflinching, slightly disgusted way. Choose the sticky, shabby or sour detail over the pretty one.",
      pacing:
        "Parcel out secrets through alternating accounts, then deliver a midpoint reversal that forces the reader to reread what came earlier. End with a chilling, unresolved stalemate rather than justice.",
      signature:
        "Make the narrator's account of herself a weapon, and expose the performance society expects from women and wives. Mix real humor with real cruelty in one paragraph.",
      avoid:
        "Avoid likable heroines who learn lessons, tidy justice and a coy narrator. Never soften a character's venom to keep them sympathetic.",
    },
  },
  {
    id: 'stieg-larsson',
    name: 'Stieg Larsson',
    genres: ['thriller', 'crime'],
    knownFor: ['The Girl with the Dragon Tattoo', 'The Girl Who Played with Fire', "The Girl Who Kicked the Hornet's Nest"],
    summary:
      "Larsson, read in English translation, writes long, methodical Scandinavian thrillers in which archive research, corporate records and journalism carry the investigation. Detail is everywhere, down to what characters buy, eat and which computers they use. A patient reporter and an uncommunicative, brilliant outsider slowly expose how institutions protect men who abuse women.",
    traits: {
      narration:
        "Use a neutral, journalistic third person that shifts among investigators, suspects and bureaucrats, reporting facts and calendar dates in order.",
      sentences:
        "Write plain, factual sentences with an unhurried, documentary rhythm. Let long paragraphs stack details of who did what and when, without stylistic flourish.",
      diction:
        "Use the vocabulary of newsrooms, finance, police and computing, with exact company names and job titles. Keep the tone neutral, even around atrocity.",
      dialogue:
        "Write matter-of-fact interviews and editorial meetings, with informants and sources questioned at length. Keep a socially withdrawn character's lines curt and literal.",
      description:
        "Inventory daily life: coffee, sandwiches, a laptop's model, a shopping receipt, a filing cabinet. Describe research materials such as photographs and old registers with close attention.",
      pacing:
        "Take a long, slow setup through financial and family backstory before the threads meet. Let breakthroughs come from documents and patient cross-referencing, and let the danger arrive late and suddenly.",
      signature:
        "Build the case on archives and data trails, showing the actual research steps. Open sections with sobering facts about violence against women to frame the plot.",
      avoid:
        "Avoid brisk minimalism, gothic mood and an all-knowing genius who skips the legwork. Do not cut the everyday detail just because it is not a clue.",
    },
  },
  {
    id: 'dean-koontz',
    name: 'Dean Koontz',
    genres: ['thriller', 'horror'],
    knownFor: ['Watchers', 'Odd Thomas', 'Intensity'],
    summary:
      "Koontz writes page-turning suspense with supernatural or science-gone-wrong elements, carried in rich, polished prose full of simile. Ordinary decent people, and often a remarkably intelligent dog, face pure evil, and the books openly believe in love and hope. Pursuit plots alternate between the sweetly domestic and the monstrous, with moral commentary woven through.",
    traits: {
      narration:
        "Use third person close to a decent, vulnerable protagonist, alternating with an unsettling villain's viewpoint. Let the narrator comment on goodness and evil.",
      sentences:
        "Write fluent, rhythmic, adjective-rich sentences, with similes and alliteration. Build long descriptive lines for mood, then shift to staccato fragments in moments of attack.",
      diction:
        "Use a broad, polished vocabulary, sometimes elevated, with weather and light rendered lyrically. Keep the villain's language coldly rational and the heroes' warmly humorous.",
      dialogue:
        "Write warm, witty banter between lovers or friends, as a defense against fear. Let the monstrous speak with an eerie, philosophical calm.",
      description:
        "Linger on California landscapes, storms, sunsets and night sounds with lush similes, and let atmosphere signal the coming threat before the monster appears.",
      pacing:
        "Begin with a sudden threat in an ordinary moment, then keep the protagonists on the run. Alternate pursuit with tender respites, and escalate to a confrontation that vindicates hope.",
      signature:
        "Pair an unusually gifted and lovable companion, often a dog, with an unstoppable evil. Let love and courage win out against nihilism, stated plainly and without embarrassment.",
      avoid:
        "Avoid cynical endings, moral ambiguity about the villain and clipped minimal prose. Never let despair have the last word.",
    },
  },
  {
    id: 'john-le-carre',
    name: 'John le Carré',
    genres: ['espionage', 'thriller', 'literary'],
    knownFor: ['The Spy Who Came in from the Cold', 'Tinker Tailor Soldier Spy', 'The Constant Gardener'],
    summary:
      "Le Carré writes espionage as office politics and moral exhaustion: tired, educated men in shabby rooms reading files and betraying friends for a cause they have stopped believing in. Long interviews and debriefings replace gunfights, and the truth surfaces through what people let slip. The prose is elegant, ironic and rich in institutional slang, and the victory, when it comes, feels like a loss.",
    traits: {
      narration:
        "Use a worldly, ironic third person that slips into a weary professional's perspective and into the service's collective memory. Move backward and forward in time as files and recollections are reopened.",
      sentences:
        "Write long, supple, well-educated English sentences full of qualification and irony, then cut with a short, cold observation. Let the rhythm suggest an old hand telling a confidential story.",
      diction:
        "Invent a closed professional slang for the trade and use it unexplained. Mix upper-class English understatement with bureaucratic euphemism for terrible things.",
      dialogue:
        "Make conversation the arena: long interrogations in which a quiet questioner lets someone talk until they give themselves away. Give each speaker a distinct class accent, verbal tic and evasion.",
      description:
        "Describe weather-stained offices, wet streets, bad food, cheap suits and the small vanities of aging men. Read character from clothing, habits and the state of a person's desk.",
      pacing:
        "Let the plot advance through reading, remembering and listening, with one small physical action carrying huge tension. Build a slow double game whose true shape appears only in the last pages.",
      signature:
        "Show that the operation demands the betrayal of the one person who trusted the hero, and that his own side is no cleaner than the enemy. End on a cold bureaucratic success that feels like damnation.",
      avoid:
        "Avoid gadgets, glamour, car chases and clear-cut heroes. Do not explain the slang, and do not let anyone feel triumphant.",
    },
  },
  {
    id: 'ian-fleming',
    name: 'Ian Fleming',
    genres: ['espionage', 'thriller'],
    knownFor: ['Casino Royale', 'From Russia, with Love', 'Goldfinger'],
    summary:
      "Fleming writes spy adventures with a connoisseur's eye: the correct way to order a meal, the exact make of a watch or gun, the mechanics of a card game. That confident specificity lends the outlandish plots a feeling of insider truth. Long, tense games of chance and grotesque villains are told at a brisk pace, in clean journalistic prose with sudden moments of sensual or brutal detail.",
    traits: {
      narration:
        "Use a brisk, close third person near a cool, cultivated agent, with the occasional knowing authorial aside about how things are properly done.",
      sentences:
        "Write clean, swift, journalistic sentences with a confident, clubbable rhythm, and let short strings of concrete nouns carry the pleasure of detail.",
      diction:
        "Name exact brands and vintages, and use the correct terms of gambling, diving, motoring and tailoring. Keep the voice urbane and mid-century, with mild, dry wit.",
      dialogue:
        "Keep exchanges short and urbane: crisp orders from a stern superior, witty flirtation, and a villain who explains his philosophy at dinner before the torture begins.",
      description:
        "Lavish attention on luxury: food, drink, clothes, cars and exotic beaches. Explain how a game is played or a machine works, and give villains one memorable physical deformity.",
      pacing:
        "Open with an assignment, linger on travel and luxury, then stage a long duel of nerve at a game table. Let it escalate to capture, ordeal and a violent escape.",
      signature:
        "Give the reader a tutorial in a rich man's pleasure, then turn that same exact attention to pain and danger. Use a game of cards or golf as the first battle with the villain.",
      avoid:
        "Avoid vague luxury, gadgets that solve everything, and a chatty modern voice. Do not name a generic drink or car when you can name the exact one.",
    },
  },
  {
    id: 'thomas-harris',
    name: 'Thomas Harris',
    genres: ['thriller', 'crime', 'horror'],
    knownFor: ['Red Dragon', 'The Silence of the Lambs', 'Hannibal'],
    summary:
      "Harris writes forensic thrillers in cool, exact prose that slips into the minds of investigators and killers alike. Procedure is rendered precisely and then charged with dread through what it implies about the person who did this. Scenes of quiet conversation between a hunter and an imprisoned expert carry more threat than the violence does, and a killer's aesthetic refinement makes him more terrible.",
    traits: {
      narration:
        "Use a cool third person with deep access to both the empathetic investigator and the killer, whose private mythology is narrated seriously. Sometimes shift to the present tense for immediacy.",
      sentences:
        "Write precise, compressed sentences that drop into sudden fragments, with odd syntax that keeps the reader slightly off balance. Use a formal calm around horrifying content.",
      diction:
        "Use the exact vocabulary of forensics, entomology, medicine, art and fine food. Keep the language elegant, and let it become most refined when the subject is most awful.",
      dialogue:
        "Stage intellectual duels through a barrier, in which a brilliant captive trades information for personal revelations. Let courtesy and insight be the threat.",
      description:
        "Report evidence closely: a smell, a fiber, a detail of how a room was arranged. Let the reader infer the horror from the clinical inventory rather than from gore.",
      pacing:
        "Advance the investigation through labs, files and interviews, cross-cutting with the killer's everyday routine and a future victim, until a clock runs out.",
      signature:
        "Make the investigator's empathy the method and the wound: to catch him she must think as he does. Let good taste, manners and scholarship be the most frightening trait of the monster.",
      avoid:
        "Avoid gore for its own sake, wisecracking cops and rushed forensics. Do not shout at the reader; lower the voice as things get worse.",
    },
  },
  {
    id: 'patricia-highsmith',
    name: 'Patricia Highsmith',
    genres: ['thriller', 'crime', 'literary'],
    knownFor: ['Strangers on a Train', 'The Talented Mr. Ripley', 'The Price of Salt'],
    summary:
      "Highsmith writes suspense from inside ordinary-seeming people who drift into crime, in flat, reasonable prose that makes the reader complicit. Guilt, envy and fascination between two people grow by small steps, and the narration never condemns. Dread comes from the banality of daily errands continuing around a secret, and from how close the reader has been brought to wanting the criminal to get away with it.",
    traits: {
      narration:
        "Stay in a close third with a person whose rationalizations are reported calmly and without comment, so that the reader finds themselves agreeing with them.",
      sentences:
        "Write plain, even, almost affectless sentences. Keep the rhythm neutral through murder and through lunch, letting the very flatness create unease.",
      diction:
        "Use ordinary, tidy, middle-class vocabulary with attention to money, clothing and social position. Never use a word that passes moral judgment.",
      dialogue:
        "Write polite small talk with a threat beneath it, as people probe what the other one knows. Let a stray question from an acquaintance land like a blow.",
      description:
        "Note daily details with an anxious eye: what things cost, a hotel room's furnishings, a hand on a cigarette. Let pretty European or suburban settings grow oppressive.",
      pacing:
        "Advance by small, plausible steps from envy to crime, then sustain a long, tight fear of discovery. Let coincidence and nagging acquaintances, rather than police, supply the pressure.",
      signature:
        "Bind two people in a mutual obsession that neither can leave. Make the reader want the wrong person to escape, and refuse to punish him on schedule.",
      avoid:
        "Avoid moralizing, shock endings, action set pieces and a clever detective who sets things right. The narration must never step outside to disapprove.",
    },
  },
  {
    id: 'harlan-coben',
    name: 'Harlan Coben',
    genres: ['thriller', 'crime', 'mystery'],
    knownFor: ['Tell No One', 'Deal Breaker', 'Gone for Good'],
    summary:
      "Coben writes suburban thrillers built on one irresistible hook: a dead wife emails, or a child who vanished years ago turns up. A wisecracking, likable first-person voice makes the reader comfortable, while the past keeps breaking into a safe New Jersey life. Secrets stack up within families and old friends, and the books end with a late twist and then one more on the last page.",
    traits: {
      narration:
        "Use a warm, joking first person from an ordinary suburban man or woman, mixed with short third-person scenes that show what the narrator cannot know.",
      sentences:
        "Write quick, easy, conversational sentences, with sarcastic asides and one-line paragraphs at the end of chapters. Make it effortless to keep reading.",
      diction:
        "Use contemporary, suburban American language, with sports, parenting and pop-culture jokes. Keep the vocabulary plain and the humor self-deprecating.",
      dialogue:
        "Write snappy banter between old friends and spouses, then tense conversations in which someone knows more than they admit. Let a dangerously funny sidekick handle the violence.",
      description:
        "Keep details familiar and quick: cul-de-sacs, Little League, commuter trains, a high school gym. Let the ordinary look ominous once a stranger has said something odd.",
      pacing:
        "Open with an impossible hook, and end almost every short chapter with a small reveal. Reverse who to trust repeatedly, and hold a final shock for the very last lines.",
      signature:
        "Let a long-buried event from youth reach up into a comfortable present. Land the main solution, let the reader relax, and then deliver one more quiet twist on the last page.",
      avoid:
        "Avoid slow openings, dark brooding detectives and procedural detail. Do not let the last chapter end where the reader expects.",
    },
  },
  {
    id: 'paula-hawkins',
    name: 'Paula Hawkins',
    genres: ['thriller', 'crime'],
    knownFor: ['The Girl on the Train', 'Into the Water', 'A Slow Fire Burning'],
    summary:
      "Hawkins writes domestic psychological thrillers told by rotating first-person women, in a diary-like present tense stamped with times and dates. Each narrator has a blind spot, and at least one cannot trust her own memory. Small voyeuristic observations of other people's lives build into a whodunit whose real subject is how women are disbelieved, and how they disbelieve themselves.",
    traits: {
      narration:
        "Rotate first-person present-tense voices of several women, heading sections with name, day and time, and let them see each other with envy and suspicion. Make one unreliable through gaps in memory.",
      sentences:
        "Write plain, immediate, slightly breathless sentences in a journal-like rhythm. Use short lines for dread, and let fragments stand for moments that a narrator cannot recall.",
      diction:
        "Use everyday contemporary British English, with attention to drink, shame and domestic routines. Keep it unliterary, as if written down to get through the day.",
      dialogue:
        "Keep conversations short and guarded, with husbands and police who reassure or dismiss the narrator. Let a casual remark contradict something she remembers.",
      description:
        "Build scenes from repeated observations of the same houses, routes and neighbors, as though seen through a window. Note small changes in a familiar view.",
      pacing:
        "Advance by alternating short sections with timestamps, giving each narrator a piece of the puzzle. Reveal in the last quarter that a trusted figure has been shaping what she remembers.",
      signature:
        "Let a compromised woman's memory be the crime scene itself, with the truth restored in fragments. Show gaslighting as the true violence behind the murder.",
      avoid:
        "Avoid heroic detectives, omniscient narration, stylish metaphor and glamorous settings. Do not let any one narrator hold the whole story.",
    },
  },
  {
    id: 'alistair-maclean',
    name: 'Alistair MacLean',
    genres: ['thriller', 'espionage', 'historical'],
    knownFor: ['The Guns of Navarone', 'Where Eagles Dare', 'Ice Station Zebra'],
    summary:
      "MacLean writes high-adventure thrillers about small groups of hard men on impossible missions in brutal terrain, often at sea or in snow. A dry, sardonic narrator keeps information to himself, and halfway through the book it turns out somebody on the team is a traitor. Punishing physical ordeal, wry understatement and repeated betrayals drive the action.",
    traits: {
      narration:
        "Often use a laconic first person, a professional who withholds his real purpose from the reader as well as from his companions, or a close third on an exhausted team leader.",
      sentences:
        "Write solid, well-paced British sentences with ironic understatement. Let long descriptions of cold or exhaustion end on a dry, flat remark.",
      diction:
        "Use technical naval, mountaineering and military terms exactly. Keep it educated and mordant, with heavy use of understatement in the face of death.",
      dialogue:
        "Write sardonic exchanges among tough specialists, who insult each other politely and say the least when the danger is worst. Let an interrogation run on false courtesy.",
      description:
        "Give the weather and terrain real power: the sea, cliffs, ice and the physical cost of crossing them. Describe weapons, boats and explosives with a professional's attention.",
      pacing:
        "Set an impossible mission with a countdown, and punish the team with storm, climb and ambush. At the midpoint reveal a traitor in the group, then a hidden plan behind the visible one.",
      signature:
        "Reveal that the mission's stated goal is a cover, and that the narrator knew more than he told us. Pile betrayal upon physical ordeal, with wit as the last thing to go.",
      avoid:
        "Avoid romance at the center, introspective brooding, easy terrain and a team that can trust each other. Do not let the hero explain his plan before it pays off.",
    },
  },
];
