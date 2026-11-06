import type { AuthorData } from '../types';

export const LITERARY: AuthorData[] = [
  {
    id: 'ernest-hemingway',
    name: 'Ernest Hemingway',
    genres: ['literary', 'classics'],
    knownFor: ['The Sun Also Rises', 'A Farewell to Arms', 'The Old Man and the Sea'],
    summary:
      "Hemingway writes plain declarative sentences and leaves the feeling under the surface, so that what is unsaid carries the weight. His stories follow people doing physical things, such as fishing, drinking, fighting and traveling, and report them without comment. Dialogue is repetitive and evasive, and the reader must infer the grief or love that nobody mentions.",
    traits: {
      narration:
        "Report what is done and seen from an outside-leaning close third or laconic first person. State actions rather than emotions, and never explain what the character feels.",
      sentences:
        "Write short declaratives joined by and, in a plain, cumulative rhythm. Repeat simple words on purpose, and let the occasional long and-chained sentence carry a physical process.",
      diction:
        "Use common Anglo-Saxon words and few adjectives. Prefer the concrete noun: wine, rain, line, knife. Leave out abstract words such as honor or love, unless a character is mocking them.",
      dialogue:
        "Write spare, circling exchanges in which people talk about the drink or the weather rather than the real subject. Use said, leave out adverbs, and let lines go untagged.",
      description:
        "Describe weather, food, terrain and the correct way to do a task in exact, simple steps. Let a physical procedure such as baiting a hook stand in for what the person is holding back.",
      pacing:
        "Let scenes unfold in near real time with few transitions, and omit the central event or the backstory on purpose. End flatly, on an action or an image, rather than a realization.",
      signature:
        "Leave out the most important thing, so that the reader feels it through its absence. Show courage as doing a job correctly under pressure, and report the loss in the same even tone.",
      avoid:
        "Avoid adverbs, ornate metaphors, stated feelings, abstract musing and summing up at the ending. Do not let a character say what the scene means.",
    },
  },
  {
    id: 'cormac-mccarthy',
    name: 'Cormac McCarthy',
    genres: ['literary', 'western', 'dystopian'],
    knownFor: ['Blood Meridian', 'No Country for Old Men', 'The Road'],
    summary:
      "McCarthy writes in a biblical, elemental register about violence and a vanishing human order, in landscapes of desert and ruin. He joins long polysyndetic sentences with sudden rare words, and he leaves out quotation marks, so that speech and stone lie on the same page. Characters barely think on the page: they act, ride, kill and endure, while the narrator looks on from something like geological time.",
    traits: {
      narration:
        "Use an impassive, far-seeing third person that rarely enters thought, recording people's acts as if they were weather. Let the narrator rise now and then to prophetic, cosmic observation.",
      sentences:
        "Chain long clauses with and, with little punctuation, in an incantatory biblical rhythm, then cut to very short plain sentences. Omit quotation marks and use apostrophes sparingly.",
      diction:
        "Set plain Anglo-Saxon words against rare, archaic and geological vocabulary. Use saddle, gun and tool terms exactly, and Spanish without translation when the setting calls for it.",
      dialogue:
        "Write minimal, flat exchanges with no quotation marks and almost no tags, in laconic rural speech. Let a rare long monologue by a menacing or wise figure turn into philosophy.",
      description:
        "Render land, light and stone at length in terms of the elemental and the ancient. Report violence and physical processes in the same unblinking, exact, unhurried way.",
      pacing:
        "Move through long passages of travel and small repetitive tasks, punctuated by sudden, extreme violence that receives no special emphasis. End without moral resolution.",
      signature:
        "Fuse scripture-like cadence with bloody or hopeless events, so that atrocity reads as sacred history. Reduce the world to fire, road, tool and a last bit of human tenderness.",
      avoid:
        "Avoid quotation marks, semicolons, psychological explanation, humor as relief and comforting endings. Do not tell the reader what any of this means.",
    },
  },
  {
    id: 'jane-austen',
    name: 'Jane Austen',
    genres: ['classics', 'romance', 'literary', 'humor'],
    knownFor: ['Pride and Prejudice', 'Emma', 'Persuasion'],
    summary:
      "Austen writes ironic social comedy about marriage, money and self-knowledge within a small circle of country families. An amused narrator glides in and out of a heroine's mind, so that a sentence can seem to agree with a character and mock her at once. Nothing larger than a ball or a proposal happens, yet moral judgment makes every small event count.",
    traits: {
      narration:
        "Use a poised, ironic third person that slides into a heroine's thoughts without marking the change, letting her vanity or error show in her own phrasing while the narrator stays quietly amused.",
      sentences:
        "Write balanced, elegant, periodic sentences in Regency English with antithesis and a dry sting at the close. Sum up a whole character in one neat, measured clause.",
      diction:
        "Use polite Georgian abstractions such as civility, amiable, sense, and income in exact annual figures. Convey disapproval only through understatement and careful word choice.",
      dialogue:
        "Let characters reveal themselves completely in their speech, from foolish monologues to courteous fencing between a witty pair. Give bores and snobs comic verbal habits, and let them never notice.",
      description:
        "Say almost nothing of faces, clothes or landscape. Describe rooms, carriages and estates mainly by what they reveal about rank and money, and keep attention on manners.",
      pacing:
        "Build through visits, dinners and letters, with misjudgment slowly corrected. Put a key letter or a humiliating moment at the turn, then let self-knowledge precede the engagement.",
      signature:
        "Use free indirect style so that the reader catches the heroine's self-deception before she does. Make the plot a moral education, in which a heroine's reversal of judgment is the real climax.",
      avoid:
        "Avoid physical passion on the page, melodrama, wild adventures, modern idioms and heavy description. Do not explain the irony or let the narrator become earnest for long.",
    },
  },
  {
    id: 'charles-dickens',
    name: 'Charles Dickens',
    genres: ['classics', 'literary', 'humor'],
    knownFor: ['Great Expectations', 'Bleak House', 'A Tale of Two Cities'],
    summary:
      "Dickens writes huge, theatrical serial novels of Victorian London, packed with grotesque comic characters, coincidences and social fury. An exuberant narrator personifies fog and furniture, repeats phrases like a preacher, and swings from farce to deathbed tears. Each minor character has a verbal tic and a memorable name, and hidden connections bind rich and poor by the end.",
    traits: {
      narration:
        "Use an exuberant, intrusive storyteller, or a looking-back first person, who addresses the reader, takes sides and moves from comic caricature to open indignation.",
      sentences:
        "Write long, rolling, rhetorical sentences that build through parallel clauses and anaphora, often with sustained repetition of a word through a paragraph like a preacher's refrain.",
      diction:
        "Use rich, comic Victorian vocabulary, with legal, commercial and street terms. Coin names that describe their owners, and give each class its own spelling of speech.",
      dialogue:
        "Give each character a catchphrase, a verbal tic or a distinctive dialect, kept up at every appearance. Let villains be unctuous, and clerks and servants comically roundabout.",
      description:
        "Animate the inanimate, so that houses leer and fog creeps like a creature. Pile up objects in long catalogues, and fix each person with a single exaggerated physical trait.",
      pacing:
        "Weave several plots with cliffhangers at the ends of chapters, as in a serial. Alternate farce and pathos, and let hidden family ties and coincidences come together near the end.",
      signature:
        "Turn an institution such as a court or a workhouse into a grotesque comic monster, and make the reader angry about it. Let the climax reveal how the lowly and the mighty were related all along.",
      avoid:
        "Avoid minimal, understated prose, unmemorable minor characters, flat neutrality about injustice and tight small casts. Don't let a character enter without a name and tic you'd remember.",
    },
  },
  {
    id: 'virginia-woolf',
    name: 'Virginia Woolf',
    genres: ['literary', 'classics'],
    knownFor: ['Mrs Dalloway', 'To the Lighthouse', 'Orlando'],
    summary:
      "Woolf writes modernist novels that follow the flow of consciousness over a day or a summer, passing from one mind to the next across a room. External events are slight, and the real action is how time, memory and sensation press upon a moment. Long, rippling sentences hold many impressions at once, and small epiphanies arrive in the middle of ordinary errands.",
    traits: {
      narration:
        "Use a free-floating third person that glides from one mind to another without a break, carried by a shared sound, glance or object. Blend thought and perception seamlessly.",
      sentences:
        "Write long, rhythmic, semicolon-linked sentences with parentheses, that hover, return and accumulate impressions. Follow them with a short, plain clause that brings the reader back to earth.",
      diction:
        "Use delicate, exact, sensory words with recurring images of water, light and waves. Let a refined English voice stay close to the fleeting impression.",
      dialogue:
        "Keep spoken exchanges slight and social, set against the much larger stream of what each speaker privately thinks. Let what isn't said create most of the meaning.",
      description:
        "Describe how things feel to a particular consciousness: a shop window's colors, the sound of a clock, the pattern of light on a wall. Let objects shine with significance.",
      pacing:
        "Structure a book around one day or a small span, moved by memory rather than plot. Let a clock or a repeated image mark the time, and compress years into a short lyrical passage.",
      signature:
        "Move from one character's stream of thought to another through a passing object or sound. Build a whole life into one ordinary moment, with a small visionary perception at its close.",
      avoid:
        "Avoid plot-driven scenes, heavy external action, clear exposition and plain summary. Don't report inner life from outside; stay within its flow.",
    },
  },
  {
    id: 'william-faulkner',
    name: 'William Faulkner',
    genres: ['literary', 'classics', 'gothic'],
    knownFor: ['The Sound and the Fury', 'As I Lay Dying', 'Absalom, Absalom!'],
    summary:
      "Faulkner writes the American South as a burden of history, in sentences that can run for pages, holding past and present at once. He tells a single family's decline through multiple, conflicting voices, sometimes broken and out of chronological order. The reader must piece together events from memory and rumor, in rhetoric that rises to an almost biblical pitch.",
    traits: {
      narration:
        "Use multiple first-person or deep interior voices, each with its own idiom, including those of the very young or the impaired. Let them disagree, and let no one offer the whole story.",
      sentences:
        "Write enormously long, comma-rich sentences that nest clauses within clauses and hold back the verb, moving by association across decades. Contrast them with chapters of terse, flat rural speech.",
      diction:
        "Use a rhetorical, Latinate high style, mixed with rural Southern vernacular spelled by ear. Repeat abstract words such as doom, honor and outrage with a growing incantatory force.",
      dialogue:
        "Render hill-country speech faithfully, with dialect and understatement. Let a family's secrets emerge in fragments from people who talk around them for pages.",
      description:
        "Describe faded houses, heat, dust and mules in long, thick rhythms, with the past visible in every object and the land itself remembering what has been done on it.",
      pacing:
        "Break chronology, circling a central event from several angles and returning to it, so that the reader learns the crucial fact late. Let time collapse in a single paragraph.",
      signature:
        "Retell the same family tragedy through conflicting voices, and let long-gone events weigh on the speakers as if still happening. Use italics to shift time without warning.",
      avoid:
        "Avoid linear exposition, tidy explanation of who is who, and minimalist restraint. Do not simplify the time shifts or smooth the regional speech.",
    },
  },
  {
    id: 'f-scott-fitzgerald',
    name: 'F. Scott Fitzgerald',
    genres: ['literary', 'classics', 'romance'],
    knownFor: ['The Great Gatsby', 'Tender Is the Night', 'This Side of Paradise'],
    summary:
      "Fitzgerald writes the glamour and sadness of American wealth in polished, lyrical prose. His narrators stand at the edge of a party and half fall in love with what they're watching, knowing that it will end. Dazzling surfaces such as light, music, cars and money are written beautifully and then shown to be empty, with a quiet ache for what has already been lost.",
    traits: {
      narration:
        "Use a reflective first person from an observer who is both inside and outside the glamorous set, admiring and judging, telling it after it is all over.",
      sentences:
        "Write graceful, musical, finely balanced sentences that rise and then fall away at the end. Use a dying cadence to close paragraphs with an ache.",
      diction:
        "Combine Jazz Age elegance with synesthetic touches, such as voices that have color or money that has sound. Use the vocabulary of parties, gardens, shirts, motor cars and old families.",
      dialogue:
        "Write brittle, careless, witty party talk, in which the rich say little and hurt each other offhandedly. Let a person's voice or manner of speech reveal their class.",
      description:
        "Light up surfaces: lawns, dresses, shimmering rooms, the color of a drink in lamplight. Keep it impressionistic and lush, and let it hint at the rot or the emptiness beneath.",
      pacing:
        "Build through a sequence of parties and meetings across one season, with the crucial past withheld and revealed in a confessional chapter. Let catastrophe come fast and be treated with cool aftermath.",
      signature:
        "Show someone who reinvents himself in pursuit of a dream of a person or a class, and show it fall. Conclude with a reflective, lyrical passage widening the story to a national longing.",
      avoid:
        "Avoid flat reportage, working-class grit, cynicism without longing and long plot explanation. Don't let the beauty go unshadowed.",
    },
  },
  {
    id: 'toni-morrison',
    name: 'Toni Morrison',
    genres: ['literary', 'historical', 'gothic'],
    knownFor: ['Beloved', 'Song of Solomon', 'Sula'],
    summary:
      "Morrison writes dense, musical, mythic novels of Black American life and history, in which memory and the supernatural are facts of the community. Language moves from the vernacular to the incantatory, and stories are circled rather than told in order. The worst things are approached slowly, from many sides, and a community's voices hold the story together.",
    traits: {
      narration:
        "Move between a communal, gossiping voice and deep interior ones, letting the past break into the present. Approach the central trauma from several angles over the whole book, naming it late.",
      sentences:
        "Write rhythmic, oral sentences with repetition, call-and-response patterns and sudden fragments. Let them shift between plain vernacular and soaring lyric within a paragraph.",
      diction:
        "Use Black American vernacular and biblical echoes, with sensory, bodily words. Make the concrete mythic, and name people and places in ways that hold family stories.",
      dialogue:
        "Write speech with music and indirection, in which women teasing, grieving or warning each other carry the community's history. Trust the rhythm and leave things unexplained.",
      description:
        "Render bodies, food, color and scars with charged, almost tactile metaphors. Treat houses and landscapes as having memories, and treat ghosts and other wonders as simply true.",
      pacing:
        "Abandon strict chronology, spiraling through time as memory does and revealing key events in fragments. Open with a striking communal statement, and hold back the worst until the reader can bear it.",
      signature:
        "Let the unspeakable history of an enslaved or oppressed people return in physical form. Have the neighborhood as a chorus, judging, protecting and failing the one who stands apart.",
      avoid:
        "Avoid linear explanation, explaining culture to an outside audience, and sentimental redemption. Do not offer the reader a simple comfort or an authorial verdict.",
    },
  },
  {
    id: 'margaret-atwood',
    name: 'Margaret Atwood',
    genres: ['literary', 'dystopian'],
    knownFor: ["The Handmaid's Tale", 'Oryx and Crake', 'Alias Grace'],
    summary:
      "Atwood writes cool, razor-witted fiction in which a watchful woman reports on her situation, with dark jokes and a poet's exact eye. Her speculative worlds extend real history and current trends rather than invent from nothing. Puns and small domestic observations carry political menace, and the reader pieces together what happened from a narrator who is careful about what she will say.",
    traits: {
      narration:
        "Use a guarded first-person present or retrospective voice from a woman reconstructing events, who admits that she is telling a version of the story and revises it as she goes.",
      sentences:
        "Write short, cool, exact sentences that fall into fragments, with sudden sardonic asides. Let a one-line paragraph deliver a joke with a blade in it.",
      diction:
        "Pay close attention to language itself, with puns, etymologies, and official euphemisms. Keep domestic words for food, fabric and gardening alongside clinical, corporate terms.",
      dialogue:
        "Keep exchanges tight and watchful, as people in a surveilled world say permitted phrases and mean something else. Let wit be a private act of resistance.",
      description:
        "Observe small domestic objects, bodies and clothes with precise and unsettling comparisons. Show the regime through its uniforms, rules and rituals rather than its politics.",
      pacing:
        "Alternate a tense present with fragments of a lost past, letting the reader assemble how things came to this. Add a framing document at the end that casts a chilly new light on it.",
      signature:
        "Base the dystopia on things that have really been done, and let a pun undo an official phrase. Close with a scholarly or ironic frame that questions the whole account.",
      avoid:
        "Avoid action heroines, rousing revolutions, heavy exposition and sentimental language. Do not let the narrator become fully trustworthy or fully hopeful.",
    },
  },
  {
    id: 'haruki-murakami',
    name: 'Haruki Murakami',
    genres: ['literary', 'fantasy'],
    knownFor: ['Norwegian Wood', 'The Wind-Up Bird Chronicle', 'Kafka on the Shore'],
    summary:
      "Murakami, read in English translation, writes deadpan, dreamlike novels in which a passive, solitary man cooks pasta and listens to jazz until the world quietly goes strange. A missing woman, talking animals or a well that leads elsewhere are reported in the same flat tone as doing the laundry. The mysteries are not solved, and the mood is loneliness made almost comfortable.",
    traits: {
      narration:
        "Use a mild, detached, slightly bemused first-person man in his twenties or thirties, who drifts through events and reports his own bewilderment calmly.",
      sentences:
        "Write simple, clear, even sentences in plain conversational rhythm. Treat a bizarre event and a sandwich with exactly the same flat, polite tone.",
      diction:
        "Use plain modern language with Western pop references: exact jazz records, novels, whisky and running shoes. Use odd, droll similes of an almost childlike exactness.",
      dialogue:
        "Write polite, gently absurd conversations with strangers who explain metaphysics in calm, literal terms. Let women speak frankly, and let the narrator answer with mild courtesy.",
      description:
        "Describe mundane routines step by step: cooking, ironing, a quiet bar, a neighborhood walk. Introduce the uncanny in a small, specific, matter-of-fact way, without fanfare.",
      pacing:
        "Let the story wander slowly, with a disappearance or a strange phone call as a starting point. Alternate parallel threads, and leave central mysteries unanswered at the end.",
      signature:
        "Pair a lonely everyday routine with a door into another reality, reached by going down into a dark place. Accept the impossible without surprise, and let small recurring motifs gain unexplained weight.",
      avoid:
        "Avoid fast plot mechanics, explanations of the surreal, emotional outbursts and tidy resolutions. Do not let the narrator become driven or sure of himself.",
    },
  },
  {
    id: 'john-steinbeck',
    name: 'John Steinbeck',
    genres: ['literary', 'classics', 'historical'],
    knownFor: ['The Grapes of Wrath', 'Of Mice and Men', 'East of Eden'],
    summary:
      "Steinbeck writes plain, compassionate stories of working people and the land, mainly in California. He alternates close family drama with wide, almost biblical chapters on whole classes of people, and he observes human groups as a marine biologist would, with sympathy. Speech is rendered in rough dialect, and landscapes open his chapters with the patience of a naturalist.",
    traits: {
      narration:
        "Use a warm, plainspoken third person near poor working families, broadening at times to a chorus-like voice speaking for a whole class of people on the move.",
      sentences:
        "Write simple, muscular sentences with some biblical parallelism, and use lists of tools, food and places. Let them become rhythmic and incantatory in the broad chapters.",
      diction:
        "Use plain American words, and exact terms for farming, machines and natural history. Render dialect by ear for field hands and migrants, with rough, gentle humor.",
      dialogue:
        "Let rural working people talk in repetitive, unlettered, deeply felt ways, about jobs, food and pride. Keep what matters most below the surface of their talk.",
      description:
        "Open chapters with close, patient naturalist description of a valley, a road or a small creature at work. Show nature first, then how people work upon it and suffer from it.",
      pacing:
        "Alternate intimate family chapters with general interchapters about the larger historical event. Move at a walking pace, through hardship and small kindnesses, to a stark moral ending.",
      signature:
        "Set the story of one family against essay-like chapters that speak for everyone in their condition. Treat the group as an organism, and honor plain people's dignity under injustice.",
      avoid:
        "Avoid clever narrators, upper-class settings and ironic detachment. Do not condescend to the poor or turn them into quaint rustic jokes.",
    },
  },
  {
    id: 'george-orwell',
    name: 'George Orwell',
    genres: ['classics', 'dystopian', 'literary'],
    knownFor: ['Nineteen Eighty-Four', 'Animal Farm', 'Burmese Days'],
    summary:
      "Orwell writes prose as clear as he can make it, about power and the corruption of language. His novels are built on a plain observational voice attentive to bad food, shabby rooms and physical fear, set against official lies. Political ideas are made concrete through daily deprivation, and the plots end in defeat, with the mechanism of tyranny laid out step by step.",
    traits: {
      narration:
        "Use a plain, disillusioned third person close to one ordinary, physically unimpressive man who sees through the system, and report his thoughts in direct and unadorned terms.",
      sentences:
        "Write clear, direct, well-made English sentences of moderate length, with no decoration and in the active voice. Let plainness itself carry the anger.",
      diction:
        "Prefer short, everyday Anglo-Saxon words. Show official language as euphemism, with invented bureaucratic terms that reveal how a regime controls thought through vocabulary.",
      dialogue:
        "Let official speakers talk in slogans and dead phrases, and let private talk be furtive and blunt. Stage a long interrogation in which a calm authority explains how power works.",
      description:
        "Attend to shabby physical reality: smells, grime, poor food, aging bodies, machines that no longer work. Use exact, unlovely detail to make the political system a bodily experience.",
      pacing:
        "Set out a system patiently, let the hero rebel in a small private way, and then spring the trap. Follow with an extended, methodical account of his breaking, and a bleak end.",
      signature:
        "Make language itself the battleground, showing a regime changing words to change what can be thought. Let a fable-simple or documentary plainness carry an appalling conclusion.",
      avoid:
        "Avoid stock phrases, pretentious diction, purple description and hopeful uprisings. Do not romanticize the rebel or leave the mechanism of power vague.",
    },
  },
  {
    id: 'kurt-vonnegut',
    name: 'Kurt Vonnegut',
    genres: ['literary', 'classic-sf', 'humor'],
    knownFor: ['Slaughterhouse-Five', "Cat's Cradle", 'Breakfast of Champions'],
    summary:
      "Vonnegut writes short-chaptered, deadpan satire in very simple sentences about atrocity, stupidity and kindness. He steps into his own novels as the author, explains his own jokes, draws little pictures, and shrugs at the horror with a refrain. Science fiction is a way to look at human foolishness from far enough away that it becomes funny and then heartbreaking.",
    traits: {
      narration:
        "Use a folksy, world-weary narrator who may step in as the author, tells you how it ends, and addresses the reader as a friend who shares this ridiculous planet.",
      sentences:
        "Write very short, plain sentences that a child could read, with short paragraphs and frequent white space. Follow a dreadful fact with a flat, simple, comic remark.",
      diction:
        "Use simple, childlike vocabulary to define grand things as if for an alien visitor. Invent comic religions, planets and terms, and explain them in the same plain tone.",
      dialogue:
        "Keep exchanges brief and absurd, with characters speaking banal lines at terrible moments. Let an unworldly person say something simple and devastating.",
      description:
        "Describe things as if to someone who has never seen Earth, with naive definitions. Report mass death in a flat, brief way, and use little line drawings or lists if you like.",
      pacing:
        "Use very short chapters and jump around in time, telling the end first. Let fragments and running gags replace suspense, and stop abruptly on a small, odd, gentle note.",
      signature:
        "Repeat a short, resigned refrain after each death or disaster, until it becomes unbearable. Interrupt the fiction with direct comments about how hard it is to write about such things.",
      avoid:
        "Avoid heroic battle scenes, long sentences, elaborate description and earnest political speeches. Do not raise your voice about the horror; shrug instead.",
    },
  },
];
