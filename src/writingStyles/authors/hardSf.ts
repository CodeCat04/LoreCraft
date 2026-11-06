import type { AuthorData } from '../types';

/** Hard science fiction and classic science fiction. */
export const HARD_SF: AuthorData[] = [
  {
    id: 'arthur-c-clarke',
    name: 'Arthur C. Clarke',
    genres: ['hard-sf', 'classic-sf'],
    knownFor: ['2001: A Space Odyssey', 'Rendezvous with Rama', "Childhood's End"],
    summary:
      'Clarke writes calm, lucid prose in which the universe itself is the main character. People are capable and lightly sketched, and the emotional payoff comes from scale, when a patient build-up of physical fact opens onto awe. His endings often lift away from the human story toward something far larger.',
    traits: {
      narration:
        'Use a detached third person that knows more than any character and can step back for cosmic or historical context. Keep inner lives brief, since people here observe and solve problems.',
      sentences:
        'Write clear, unhurried, balanced sentences of moderate length. Build toward a quiet declarative at the end of a paragraph, and let one plain sentence carry the moment of wonder.',
      diction:
        'Use exact scientific terms, explained in passing like good popular science. Keep the register educated, courteous and lightly wry, never slangy or breathless.',
      dialogue:
        "Keep talk polite, intelligent and functional: professionals trading information and dry understatement. A crew's calm voices should make the danger feel larger.",
      description:
        'Convey size through physics: how long light takes to cross something, how a thrown object behaves, how a structure compares with something familiar. Favor engineering and astronomical panoramas over faces and rooms.',
      pacing:
        'Proceed by patient exploration, giving each short chapter one new discovery or physical problem. Withhold explanation so the mystery grows, and leave the largest questions partly unanswered.',
      signature:
        'Close a major section on a quiet jolt of perspective, a last line that shows the true scale of what just happened. Let alien intelligence approach the feeling of the sacred without leaving reason behind.',
      avoid:
        'Leave out melodrama, scheming villains, romance as an engine and florid emotion. Nothing should break the sense of a rational mind gazing steadily at something immense.',
    },
  },
  {
    id: 'robert-a-heinlein',
    name: 'Robert A. Heinlein',
    genres: ['classic-sf', 'hard-sf', 'military-sf'],
    knownFor: ['The Moon Is a Harsh Mistress', 'Starship Troopers', 'Stranger in a Strange Land'],
    summary:
      'Heinlein writes in an easy, talkative American voice, often through a capable first-person narrator who explains how things really work. His futures feel lived-in because details arrive offhandedly and the reader is trusted to keep up. Long stretches are argument, with a mentor laying out ideas while the plot waits, before practical problem-solving takes over.',
    traits: {
      narration:
        'Favor a knowing first-person narrator or a close third attached to a capable person. Talk to the reader with confidence, as though explaining how the world actually runs.',
      sentences:
        'Write brisk, conversational sentences with a plain American rhythm. Mix short assertions with chatty asides, and let the narrator break in on their own thought.',
      diction:
        'Use colloquial, no-nonsense words with engineering and military shop talk. Coin practical future slang and use it with no glossary, so the reader learns it from context.',
      dialogue:
        'Let talk run long as quick, clever debate. Give a blunt older mentor strong opinions and rapid Socratic questions, and give younger characters the nerve to push back.',
      description:
        'Reveal the setting sideways through a household gadget, a bill, or a local custom mentioned without explanation. Spend words on how a society or machine works, not on scenery.',
      pacing:
        'Alternate practical action with long stretches of talk. Solve problems by reasoning on the page, and jump months or years with a quick summary when nothing interesting happens.',
      signature:
        'Treat competence as the central virtue: people learn a skill, do the arithmetic and take responsibility for the result. Have a character state a contrarian rule of life as if it were obvious.',
      avoid:
        'Steer clear of purple prose, hand-wringing and helpless protagonists. Never stop to explain an invented detail that a native of this world would take for granted.',
    },
  },
  {
    id: 'isaac-asimov',
    name: 'Isaac Asimov',
    genres: ['classic-sf', 'hard-sf'],
    knownFor: ['Foundation', 'I, Robot', 'The Caves of Steel'],
    summary:
      "Asimov's prose is deliberately transparent: the idea is the hero, and plain language stays out of its way. His stories work like puzzles, with people talking a problem through in rooms until logic produces a reversal. Action often happens offstage and gets reported, so the drama lies in the reasoning.",
    traits: {
      narration:
        'Use a neutral, unobtrusive third person with little interiority. Report what people say and conclude, and keep the narrator free of lyrical commentary.',
      sentences:
        'Keep sentences plain and clear, with simple grammar and no ornament. Choose the clearest statement over the prettiest, in the manner of a patient explainer.',
      diction:
        'Use everyday words and straightforward scientific concepts. Keep invented terms few, and have someone define them in conversation.',
      dialogue:
        "Make talk the main engine: long exchanges where people argue hypotheses, test each other's logic and spring conclusions, with dry humor and slightly formal courtesy.",
      description:
        'Give a room or a person only a few lines, then return to the talk. Convey vast settings through logistics, such as how a huge city gets fed.',
      pacing:
        'Build each story as a fair puzzle: a stated rule, a paradox arising from that rule, then a solution. Skip battles and crises by jumping ahead and having people discuss the outcome.',
      signature:
        'Deliver the climax as a conversation in which one person reveals a twist the reader could have reasoned out. Let a small, explicit set of rules generate all the trouble.',
      avoid:
        'Sensory lushness, violent set pieces and emotional outbursts should not be turning points. The resolution must come from reasoning, never from force or luck.',
    },
  },
  {
    id: 'andy-weir',
    name: 'Andy Weir',
    genres: ['hard-sf', 'humor'],
    knownFor: ['The Martian', 'Project Hail Mary', 'Artemis'],
    summary:
      'Weir turns worked science problems into suspense, following a wisecracking problem-solver through disaster one calculation at a time. The voice is casual, nerdy and self-mocking, which makes the numbers fun and the danger bearable. Every plot turn comes from physics or engineering: something breaks, the hero does the math, and the fix creates the next problem.',
    traits: {
      narration:
        'Write a chatty first person, close to a log entry or direct talk to the reader, from a scientifically trained hero who narrates their reasoning as it happens.',
      sentences:
        'Use short, punchy sentences and fragments, with a one-line joke breaking the flow. Drop a quick calculation or step list into the narration when the problem calls for it.',
      diction:
        'Mix real units and engineering terms with casual slang and the occasional swear. Explain science as a funny friend would, with plain comparisons and sarcastic asides.',
      dialogue:
        'When others appear, keep it rapid, teasing and focused on the problem. Smart colleagues joke under pressure, and experts argue trade-offs briskly.',
      description:
        'Describe equipment, quantities and procedures rather than scenery: how much water, how many watts, how long a seal will hold. Treat the setting mainly as a list of constraints.',
      pacing:
        'Run a relentless cycle of problem, analysis, clever fix, then a new failure caused by the fix. End sections on a reversal or a wry, understated line about how bad things just got.',
      signature:
        "Show the actual working, with numbers the reader could check. Use humor as the hero's coping mechanism at moments of mortal danger, and let a small success feel like a huge victory.",
      avoid:
        'No hand-waved science, gloomy introspection or lyrical passages. The hero keeps working the problem instead of despairing, and no convenient technology solves it.',
    },
  },
  {
    id: 'neal-stephenson',
    name: 'Neal Stephenson',
    genres: ['hard-sf', 'cyberpunk', 'humor'],
    knownFor: ['Snow Crash', 'Cryptonomicon', 'Seveneves'],
    summary:
      'Stephenson writes big, digressive novels where the tangents are the pleasure, so an essay on how an old technology works can sit in the middle of a chase. The narration is wry and hyperarticulate, comparing the grand to the mundane. Ideas from computing, history and science get explained at length and with relish, and plots collide across large casts.',
    traits: {
      narration:
        "Use an intrusive, amused third person that knows everything and loves explaining it. Let it slide into a character's nerdy way of seeing the world, or leave the scene for pages.",
      sentences:
        'Write long, clause-stacking, confident sentences that build a joke or an argument, then puncture them with a short flat one. Allow long paragraphs that work an idea through thoroughly.',
      diction:
        'Combine technical jargon, academic vocabulary, slang and exact product names in one breath. Treat engineering and mathematics as dramatic subjects worth precise wording.',
      dialogue:
        "Make people hyper-competent talkers who lecture, quibble and joke, often at cross-purposes. Let an expert's extended explanation be interrupted by someone's skeptical wisecrack.",
      description:
        'Describe systems: how a network, a currency, a machine or an institution actually operates. Use elaborate comic analogies that map the technical onto everyday life.',
      pacing:
        'Interleave several plotlines with long digressions, then accelerate into sprawling set pieces. Accept a long setup, and reward it with payoffs where earlier explanations suddenly matter.',
      signature:
        'Insert an essay-like tangent on the history or mechanics of something, delivered with comic gusto and later crucial to the plot. Push an extended metaphor further than anyone expected.',
      avoid:
        'Avoid brevity for its own sake, vague science and hushed minimalism. Never apologize for a digression or cut an explanation short to reach the next plot beat.',
    },
  },
  {
    id: 'liu-cixin',
    name: 'Liu Cixin',
    genres: ['hard-sf'],
    knownFor: ['The Three-Body Problem', 'The Dark Forest', "Death's End"],
    summary:
      "Liu writes idea-first science fiction on a staggering scale of time and space, where humanity's survival becomes a problem in physics and game theory. Characters often serve as witnesses to events far larger than themselves. In English translation the prose is plain and expository, letting concepts and cold conclusions deliver the shock.",
    traits: {
      narration:
        'Use a distant, chronicler-like third person that can leap across centuries and summarize whole civilizations. Follow individuals as witnesses to history, and let history dwarf them.',
      sentences:
        'Write plain, declarative, expository sentences, closer to a historical account or scientific report than lyrical fiction. Let a flat statement carry a terrifying fact.',
      diction:
        'Use real physics, astronomy and mathematics terms along with strategic and political vocabulary. Stay sober and factual, stating extreme ideas in a matter-of-fact tone.',
      dialogue:
        'Use talk to reason through ideas: scientists, officers and officials state positions at length, almost as formal argument. Keep emotion restrained, even when the subject is extinction.',
      description:
        'Describe colossal engineering and cosmic phenomena as concrete thought experiments, spelling out sizes, timescales and consequences. Render mass events through their numbers and strange visual spectacle.',
      pacing:
        'Let slow setup and long lectures lead to huge conceptual reveals. Jump forward between sections under plain dated headings, and treat each reveal as a change in the rules for the whole species.',
      signature:
        'Follow an idea from physics or game theory to its coldest conclusion, then show it playing out on a civilization. Build a set piece around one impossible, scientifically framed image.',
      avoid:
        'Keep intimate character drama, comic banter and small stakes away from the center. Never soften a bleak logical outcome to comfort the reader.',
    },
  },
  {
    id: 'alastair-reynolds',
    name: 'Alastair Reynolds',
    genres: ['hard-sf', 'space-opera'],
    knownFor: ['Revelation Space', 'House of Suns', 'Pushing Ice'],
    summary:
      'Reynolds writes dark, gothic space opera that keeps to hard limits such as no faster-than-light travel. Time dilation stretches plots over centuries, and ancient alien catastrophes lurk in the deep background. The mood is cold, baroque and patient, filled with decaying ships and augmented people who have become strange.',
    traits: {
      narration:
        'Use several threads in third person or a reflective first person, separated by decades of slower-than-light travel, and let them converge only late in the book.',
      sentences:
        "Write measured, lucid, slightly formal sentences that can open into a long technical passage, then return without fuss to a person's fear or regret.",
      diction:
        'Use real astrophysics and plausible engineering alongside a grim, gothic vocabulary for ruined ships, contagion and body modification. Coin cold, functional names for factions and machines.',
      dialogue:
        'Keep exchanges tense and guarded among people with hidden agendas and centuries-old grudges. They sound educated, tired and reluctant to explain.',
      description:
        'Linger on huge decaying machines and artifacts of unknown purpose: hulls the size of cities, dead worlds, inscrutable mechanisms. Give them the eerie weight of a cathedral or a ruin.',
      pacing:
        'Build slowly through layered mystery and long journeys where relativity costs people everything they left behind. Let revelations about extinction in the deep past arrive late and recast the plot.',
      signature:
        'Treat lightspeed as a hard limit, and make the time lost to travel a source of grief and plot. Fill the background with slow dread about why the galaxy is so silent.',
      avoid:
        'Rule out faster-than-light shortcuts, breezy quips and cheerful crews. Aliens should stay truly strange rather than humans in costume.',
    },
  },
  {
    id: 'kim-stanley-robinson',
    name: 'Kim Stanley Robinson',
    genres: ['hard-sf', 'literary'],
    knownFor: ['Red Mars', 'The Ministry for the Future', 'New York 2140'],
    summary:
      "Robinson writes long, humane, deeply researched novels about how societies tackle huge problems, treating politics, ecology and economics as adventure. Mountains and landscapes get a hiker's love and a geologist's knowledge. Characters argue, form committees, fall in love and grow old as the plot moves across decades of collective effort.",
    traits: {
      narration:
        'Use close third rotating through a large cast of scientists, diplomats and activists, with room for essayistic overviews from outside any character.',
      sentences:
        'Write flowing, accumulating sentences heavy with lists of specifics, then shift to a plain explanatory style for passages on policy or science.',
      diction:
        'Draw on geology, climatology, economics and law. Use accurate technical vocabulary calmly, and treat the language of governance as interesting rather than dry.',
      dialogue:
        'Write lengthy arguments among people with sincere, conflicting politics, so that meetings, negotiations and late-night debates become the drama. Disagreement stays civil yet consequential.',
      description:
        'Give extended, loving landscape passages grounded in real science: rock types, weather, snow, light and how walking feels. Let the place change the person crossing it.',
      pacing:
        'Move slowly across years and decades, advancing through projects, treaties and social change. Mix in documents, lists or short expository chapters, and accept that climaxes can be collective.',
      signature:
        "Treat science and politics as a utopian struggle in progress, with credible institutions and real trade-offs. Make a long walk through rough country a character's turning point.",
      avoid:
        'Lone heroes who fix everything, simple villains and tidy endings all break this voice. Never treat economics, science or meetings as background to skim.',
    },
  },
  {
    id: 'vernor-vinge',
    name: 'Vernor Vinge',
    genres: ['hard-sf', 'space-opera'],
    knownFor: ['A Fire Upon the Deep', 'A Deepness in the Sky', 'Rainbows End'],
    summary:
      'Vinge combines grand speculative concepts with intricate plotting, and he pays particular attention to alien minds and networked information. Much of the drama comes from who knows what and how signals travel. His aliens grow from one biological premise, followed with rigor until their society and viewpoint feel natural.',
    traits: {
      narration:
        'Use close third across several threads, including inside truly alien viewpoints. Render their perceptions in their own terms until the reader adopts them.',
      sentences:
        'Write clean, efficient sentences that carry concepts without ornament. Set off network traffic as terse posts with sender headers and garbled words, so the format itself tells a story.',
      diction:
        'Use computing and information-theory vocabulary with precision. Translate alien concepts into familiar words so they read as natural, and let the reader notice the differences slowly.',
      dialogue:
        'Make people speak under information limits: delays, garbled translation, scraps of messages, network chatter. Misunderstanding and partial knowledge should be plot-critical.',
      description:
        "Describe how an alien body or a society's technology constrains thought and action. Emphasize bandwidth, communication limits and the physical logic of a strange environment.",
      pacing:
        'Run parallel threads with ticking clocks, slow-building schemes and reveals that turn on information. Reward patience with a sharp reversal when a long con or hidden fact surfaces.',
      signature:
        'Derive an alien species from one unusual biological premise, and show its whole culture following from it. Make information, its speed and who controls it the real weapon.',
      avoid:
        'Humans-in-makeup aliens, magical hacking and solutions from nowhere do not belong here. Technical details must stay consistent and must matter.',
    },
  },
  {
    id: 'ray-bradbury',
    name: 'Ray Bradbury',
    genres: ['classic-sf', 'dystopian', 'fantasy'],
    knownFor: ['Fahrenheit 451', 'The Martian Chronicles', 'Something Wicked This Way Comes'],
    summary:
      'Bradbury writes science fiction and fantasy as prose poetry, in rushing, image-drunk sentences steeped in nostalgia and dread. Small-town American childhood, Mars and the traveling carnival are equally dreamlike. The technology barely matters, because the real subject is feeling, memory and what is being lost.',
    traits: {
      narration:
        'Use an incantatory third person close to a sensitive, wondering mind, at times almost a storyteller chanting a fable. Let emotion color every perception.',
      sentences:
        'Write breathless, rhythmic sentences chained with repeated conjunctions and echoing phrases, broken by short exclamations. Aim for the sound of a poem: lists, refrains and sudden metaphors.',
      diction:
        'Prefer simple, sensory, childlike words charged with metaphor: seasons, fire, rockets, attics, wind, ash. Stay away from technical vocabulary and real science terms.',
      dialogue:
        'Make speech stylized, poetic and slightly theatrical. Children and old people talk in heightened, wistful ways about big questions.',
      description:
        'Flood the page with smell, taste, color and season. Treat objects and weather as alive, describing machines as animals and towns as memories.',
      pacing:
        'Work by mood rather than plot, in short vignettes or linked tales. Build toward one haunting image or a quiet dark twist instead of a solved mechanism.',
      signature:
        'Set nostalgia against menace, with a golden summer or autumn soured by something waiting. Let one metaphor grow and run until it becomes the scene itself.',
      avoid:
        'Avoid technical explanation, cold detachment and flat reportage. Never explain how the rocket or the magic works.',
    },
  },
  {
    id: 'philip-k-dick',
    name: 'Philip K. Dick',
    genres: ['classic-sf', 'dystopian'],
    knownFor: ['Do Androids Dream of Electric Sheep?', 'Ubik', 'The Man in the High Castle'],
    summary:
      'Dick writes fast, plainspoken, paranoid fiction in which reality itself is in doubt. His heroes are harried little men with failing marriages and money worries, stumbling on the discovery that the world is fake or that they may not be human. Comedy and despair sit together in shabby futures full of malfunctioning gadgets.',
    traits: {
      narration:
        "Use close third with rapid shifts among several ordinary, anxious people. Stick to each one's worried thoughts and petty concerns, and let their certainty about what is real collapse.",
      sentences:
        'Write plain, hurried, functional sentences, with interior questions and abrupt turns, caring more about the thought than the polish. Let a flat phrase suddenly touch something metaphysical.',
      diction:
        'Mix cheap commercial future-speak, invented brand names and drug slang with theological and philosophical terms. Keep the register working-class, and give people odd job titles.',
      dialogue:
        'Write nervous, bickering, often comic conversation in which bosses, spouses and machines nag or hustle. People argue about what is real the way they argue about money.',
      description:
        'Furnish a shabby, broken-down future of rude appliances, decaying apartments and advertising everywhere. Describe things through what has gone wrong with them.',
      pacing:
        'Move fast through short chapters and plot swerves, with each explanation of reality overturned by the next. Let the ending undo the last certainty rather than settle it.',
      signature:
        'Plant one small wrong detail that reveals the world is a fake, or that a person is not who they think. Treat the capacity for empathy as the real measure of being human.',
      avoid:
        'Polished heroes, gleaming utopias and confident explanations are out of place. Never restore a stable reality in the last chapter.',
    },
  },
  {
    id: 'william-gibson',
    name: 'William Gibson',
    genres: ['cyberpunk', 'classic-sf'],
    knownFor: ['Neuromancer', 'Count Zero', 'Pattern Recognition'],
    summary:
      'Gibson writes dense, stylish, noir-inflected prose in which the future arrives as street-level texture: brand names, black markets and worn-out hardware. Sentences are compressed and cool, and technology is described by its feel and its subculture rather than its workings. Plots are heist-like and elliptical, leaving much to be inferred.',
    traits: {
      narration:
        'Use a cool, close third person attached to a marginal professional such as a hacker, courier or fixer. Stay at street level, and never explain what the character already knows.',
      sentences:
        'Write compressed, polished sentences, often dropping the verb or ending on an unexpected concrete noun. Stack clipped fragments of perception into short, dense paragraphs.',
      diction:
        'Fill the prose with brand names, designer labels, street slang and unexplained tech terms. Favor the exact name of a thing, and let the reader catch up from context.',
      dialogue:
        'Keep talk terse, oblique and laced with slang. People in shady trades speak around the deal, and the real meaning sits under what gets said.',
      description:
        'Describe surfaces: fabric, chrome, neon, cheap surgery, the weave of a coat, garbage in a corner. Use surprising similes that fuse technology with nature or decay.',
      pacing:
        "Cut between threads in short scenes as a crew and a job take shape. Keep motives partly hidden, and let the plot's shape emerge only near a hard, elliptical climax.",
      signature:
        "Put high technology in the hands of people at the bottom, repurposed and second-hand. Describe objects by their provenance and make, like a collector's notes.",
      avoid:
        'Avoid exposition, gee-whiz explanation and clean futurism. Never gloss the slang or show gleaming utopian cities.',
    },
  },
  {
    id: 'frank-herbert',
    name: 'Frank Herbert',
    genres: ['classic-sf', 'space-opera'],
    knownFor: ['Dune', 'Dune Messiah', 'Children of Dune'],
    summary:
      "Herbert writes weighty, layered science fiction about ecology, religion and power. Scenes are webs of calculation, with the narration dipping into each person's private suspicion as they read one another's faces and voices. Epigraphs from invented future histories and scriptures give events the gravity of legend before they happen.",
    traits: {
      narration:
        'Use an omniscient third person that hops between heads within a scene, exposing what each person conceals, suspects and plans. Reveal schemes early so the reader watches the traps close.',
      sentences:
        'Write grave, measured sentences with an aphoristic ring, mixing short declarations with interior analysis. Set private thoughts in italics as lines of their own.',
      diction:
        'Use a solemn, slightly archaic register with the vocabulary of ecology, politics and religion. Coin terms with roots in old real-world languages, and let context explain them.',
      dialogue:
        'Make conversation a duel in which each sentence has a hidden second meaning and tone of voice gets analyzed. Follow a spoken line with a thought that undercuts it.',
      description:
        'Describe environments as systems: water, climate, food chains, and how scarcity shapes ritual and law. Favor the harsh and elemental over the decorative.',
      pacing:
        'Open each chapter with an epigraph from a future history, scripture or commentary that foreshadows events. Build slowly through conspiracy and dread, and keep violence short and decisive.',
      signature:
        'Nest schemes inside other schemes and state the outcome in advance, so tension comes from how it happens. Treat heroes and prophecy as political forces that the characters can see being manufactured.',
      avoid:
        'Breezy humor, gadget-driven plots and simple good against evil all break the mood. Never leave a conversation at surface value.',
    },
  },
  {
    id: 'ursula-k-le-guin',
    name: 'Ursula K. Le Guin',
    genres: ['classic-sf', 'fantasy', 'literary'],
    knownFor: ['The Left Hand of Darkness', 'The Dispossessed', 'A Wizard of Earthsea'],
    summary:
      "Le Guin writes clear, quiet, carefully weighted prose with an anthropologist's eye for how societies and languages shape people. Her tone can be that of a myth or a field report, and often both at once. Conflict tends to resolve through understanding and moral change rather than battle, and the sentences are made to be read aloud.",
    traits: {
      narration:
        'Use a calm, thoughtful voice close to a storyteller or ethnographer. Often place an outsider in a foreign culture, and let them slowly discover that their assumptions were the strange thing.',
      sentences:
        'Write clean, balanced, rhythmic sentences, plain but musical and meant for the ear. Place simple words with care, and let paragraphs end on quiet cadences.',
      diction:
        'Keep words simple, concrete and exact, with a faint formality. Use anthropological ideas lightly, and invent names and words that feel like real languages.',
      dialogue:
        "Write spare, grave, courteous exchanges where people from different cultures carefully feel out each other's meaning. Let silences and customs of speech matter.",
      description:
        'Describe weather, food, work, kinship, ritual and the physical cost of travel, as a careful observer would. Keep landscapes spare, and let them reveal what a culture values.',
      pacing:
        'Let the story unfold slowly through journey and reflection, weaving in folk tales, myths or reports as separate chapters. Aim for moral change, not a battle.',
      signature:
        'Build a society that differs from ours in one carefully thought-through way, and let the reader feel how that changes everything. Frame it with a sense of balance between opposed forces that need each other.',
      avoid:
        'Leave out bombast, battle-driven climaxes, gadget worship and triumphant conquest. Never rush past a quiet moment to reach an action beat.',
    },
  },
  {
    id: 'octavia-e-butler',
    name: 'Octavia E. Butler',
    genres: ['classic-sf', 'dystopian', 'literary'],
    knownFor: ['Kindred', 'Parable of the Sower', 'Dawn'],
    summary:
      'Butler writes lean, unflinching, direct prose about survival, power and bodily autonomy. Her protagonists, often Black women, must endure and adapt in situations with no clean choices, negotiating with those who hold power over them. She states terrible things plainly and without melodrama, so the reader has to carry the moral weight.',
    traits: {
      narration:
        'Favor first person or close third from a clear-eyed woman forced to adapt, telling what happened with steady honesty and very little self-pity.',
      sentences:
        'Write plain, direct, economical sentences with little figurative language. Hold the same even tone for horrors and for daily chores.',
      diction:
        'Use accessible, unadorned words, with precise biological terms when the body is at issue. Name what is done to people without euphemism or rhetoric.',
      dialogue:
        'Write wary negotiations between people with unequal power. Talk should reveal who can compel whom, with bargaining and resentment running beneath polite phrases.',
      description:
        'Describe the body and its vulnerabilities, hunger, labor and confinement, matter-of-factly. Spend words on what it takes to stay alive, not on scenery.',
      pacing:
        'Keep tension steady as one hard choice leads to the next, each compromise costing something. Use a journal or simple chronology, and let dread build by accumulation.',
      signature:
        'Give the protagonist a bargain that is neither victory nor defeat: survival at the price of autonomy or complicity. Explore hierarchy through intimate, uncomfortable relationships with alien or powerful others.',
      avoid:
        'Easy heroics, clean rescues and moralizing speeches have no place here. Never make suffering pretty or resolve the power imbalance neatly.',
    },
  },
  {
    id: 'hg-wells',
    name: 'H.G. Wells',
    genres: ['classic-sf', 'classics'],
    knownFor: ['The Time Machine', 'The War of the Worlds', 'The Invisible Man'],
    summary:
      'Wells grounds fantastic premises in a plain, journalistic English voice, as if reporting a strange event that really happened. Everyday places and lower-middle-class detail make the impossible credible. One scientific conceit is followed logically to its social meaning, and the tone mixes the sober, the satirical and the melancholy.',
    traits: {
      narration:
        'Use a first-person witness or sober reporter who recounts events afterward, with place names and an air of documented testimony. Often frame the story as something told to listeners.',
      sentences:
        'Write clear, well-made late-Victorian sentences of moderate length, plain rather than ornate, moving steadily with a touch of dry irony.',
      diction:
        "Use educated, slightly period English and a layperson's scientific terms. Keep the vocabulary sober so the extraordinary reads like news.",
      dialogue:
        'Keep talk sparing and marked by class. Shopkeepers, villagers and scientists react in their own idioms, often comically failing to grasp what is happening.',
      description:
        'Fix events on real roads, towns and domestic details, then introduce the impossible thing with close physical observation, as a naturalist would describe a specimen.',
      pacing:
        'Introduce one fantastic premise, establish credibility slowly, then escalate through consequences to disaster or bleak insight. Let the ending widen from one person to the fate of society or the species.',
      signature:
        "Allow a single impossibility, then reason rigorously from it, using it to comment on class, empire or evolution. Close with a chilling sense of humanity's small place in natural history.",
      avoid:
        "Avoid multiple conceits, breathless gadgetry and modern slang. Never let heroics replace the sober witness's account.",
    },
  },
  {
    id: 'jules-verne',
    name: 'Jules Verne',
    genres: ['classic-sf', 'classics'],
    knownFor: ['Twenty Thousand Leagues Under the Seas', 'Journey to the Center of the Earth', 'Around the World in Eighty Days'],
    summary:
      'Verne writes encyclopedic adventure: gentlemen travelers, exact measurements and long catalogues of geography and natural history woven through a voyage. The narrator delights in facts and machines, and the comedy comes from precise characters meeting unpredictable nature. Wonder is instructive, so the reader learns real things while being thrilled.',
    traits: {
      narration:
        "Use a genial, informative narrator or a learned first-person observer who records the journey with dates and positions, like a ship's log.",
      sentences:
        'Write formal, courteous nineteenth-century sentences, often long and orderly, with frequent exclamations of wonder and polite asides.',
      diction:
        'Use the vocabulary of science, navigation and natural history, naming species, instruments, minerals and coordinates in full. Keep a slightly old-fashioned politeness.',
      dialogue:
        'Write exchanges among a learned enthusiast, a loyal companion and a skeptic, serving exposition as lively question and answer. Comic types keep to their habits.',
      description:
        "Catalogue: list creatures by genus, give a vessel's dimensions and depth in exact units, and explain how each device works. Let the facts themselves create the wonder.",
      pacing:
        'Organize the book as an itinerary of one marvel or danger after another, each resolved by ingenuity. Pause for instructive lectures, and race the calendar when there is a deadline.',
      signature:
        'Make a machine or a route the star, explain it with numbers, then put it to the test. The reader should feel they learned real geography on an impossible trip.',
      avoid:
        'Deep psychological interiority, sexuality, cynicism and vague wonder break the spell. Give a measurement or a name wherever one could be given.',
    },
  },
];
