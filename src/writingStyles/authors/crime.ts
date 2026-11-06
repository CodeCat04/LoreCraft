import type { AuthorData } from '../types';

export const CRIME: AuthorData[] = [
  {
    id: 'agatha-christie',
    name: 'Agatha Christie',
    genres: ['mystery', 'crime', 'classics'],
    knownFor: ['Murder on the Orient Express', 'And Then There Were None', 'The Murder of Roger Ackroyd'],
    summary:
      "Christie writes clean, quick, deceptively simple puzzles with a closed circle of suspects, all of whom have something to hide. The plain prose hides clues in plain sight, and much of the fun is misdirection: the reader is told the crucial fact and looks the other way. Character is sketched in quick social types, and the solution lands in a formal gathering where everything is rearranged.",
    traits: {
      narration:
        "Use an unobtrusive third person, or a chatty observer who is less clever than the detective. Report what is said and seen fairly, without entering the mind of anyone who might be guilty.",
      sentences:
        "Write short, clear, conversational sentences in light English prose. Keep paragraphs brief and the wording easy, so that a clue slides past as ordinary chatter.",
      diction:
        "Use polite, plain, mid-century English of the servants and the well-off. Keep it modest, without technical forensics, and with mild social comedy in the word choices.",
      dialogue:
        "Let dialogue carry most of each chapter. Run the plot through interviews in which each suspect's gossip, snobbery and lies reveal character, and hide one key fact in an offhand remark.",
      description:
        "Give only what the puzzle needs: a floor plan, a timetable, who sat where, what was on the tray. Sketch people by class and one telling habit.",
      pacing:
        "Introduce the group, commit the crime early, then interview each in turn, with a second death when interest might sag. Hold the explanation for a final gathering of all the suspects.",
      signature:
        "Play fair and misdirect: state the vital fact in a way that invites the wrong assumption. Reverse the reader's first conclusion by showing that the least suspicious role was the mask.",
      avoid:
        "Avoid gore, procedural forensics and long psychological brooding. Never withhold a clue that the detective used, and never solve it by coincidence.",
    },
  },
  {
    id: 'raymond-chandler',
    name: 'Raymond Chandler',
    genres: ['crime', 'mystery', 'classics'],
    knownFor: ['The Big Sleep', 'Farewell, My Lovely', 'The Long Goodbye'],
    summary:
      "Chandler writes hardboiled crime as a kind of city poetry: a tired, honorable private eye narrates Los Angeles in wisecracks and startling similes. The plots are tangled, and the real interest is the voice, the corruption and the way wealth rots everyone. Each room and each client is sized up in a line, and a lonely decency runs under the sarcasm.",
    traits: {
      narration:
        "Use first-person past from a solitary private detective, cynical on the surface and quietly romantic beneath, who narrates everything with weary amusement and a code of his own.",
      sentences:
        "Write plain American sentences that end with a surprise. Pace them with a laconic beat, and let a long descriptive run finish on a dry, deflating clause.",
      diction:
        "Mix period slang with unexpected literary words, using concrete objects from the city. Coin elaborate comic similes, each one specific to the person or room in question.",
      dialogue:
        "Write verbal fencing with cops, gangsters and rich clients. The hero answers threats with cracks, and gets hit for it. Nobody says what they want directly.",
      description:
        "Open scenes with a sharp inventory of clothes, furniture and weather, and read class and corruption from them. Treat Southern California as a character: heat, canyons, neon, money and decay.",
      pacing:
        "Follow a walk-and-talk structure: one interview after another, each with a beating, a body or a new lie. Let the plot grow knotted, and make the emotional resolution matter more than the puzzle.",
      signature:
        "Fire off a simile no one saw coming, comically exact and faintly sad. Let the hero refuse money or a woman out of principle, then show that the principle earns him nothing.",
      avoid:
        "Avoid stock tough-guy clichés, cheerful endings, clean procedural logic and sincere speeches about honor. Don't write a metaphor that could be applied to any room.",
    },
  },
  {
    id: 'dashiell-hammett',
    name: 'Dashiell Hammett',
    genres: ['crime', 'mystery', 'classics'],
    knownFor: ['The Maltese Falcon', 'Red Harvest', 'The Thin Man'],
    summary:
      "Hammett writes the original objective hardboiled style: hard, fast, external narration with almost no access to feelings. The detective is a working professional, as violent and devious as those he hunts, and the world is corrupt from top to bottom. Motives must be inferred from gestures, because the prose is a camera that refuses to comment.",
    traits: {
      narration:
        "Report only what can be seen and heard. Use an external camera-eye third person or a blunt first-person operative who states actions and gives no account of his feelings.",
      sentences:
        "Write lean, flat, fast declarative sentences with strong verbs and almost no figurative language. Let a list of small physical actions stand in for emotion.",
      diction:
        "Use terse American working slang of the criminal and detective trades. Keep the words short, and prefer the blunt noun to anything decorative.",
      dialogue:
        "Make the dialogue the main action: long, sly, lying exchanges among crooks and clients, with everyone negotiating. Let polite phrases hide threats, and give the villain chatty charm.",
      description:
        "Describe faces and bodies with a cold, precise inventory, as if filling out a police report. Note exactly what a character's hands do while they speak, rather than saying what they feel.",
      pacing:
        "Keep moving through double-crosses, with violence quick and matter-of-fact. Let the detective stir up rival factions and watch what breaks, rather than deducing from clues.",
      signature:
        "Never say what the hero feels, leaving the reader unable to tell whether he loves or is setting up the other person until the final act. Treat crime as a business that everyone is in.",
      avoid:
        "Avoid interior monologue, ornate similes, sentimentality and a purely moral detective. Do not tell the reader what a silence means.",
    },
  },
  {
    id: 'arthur-conan-doyle',
    name: 'Arthur Conan Doyle',
    genres: ['mystery', 'crime', 'classics'],
    knownFor: ['A Study in Scarlet', 'The Hound of the Baskervilles', 'The Adventures of Sherlock Holmes'],
    summary:
      "Conan Doyle tells his detective stories through a loyal, admiring, less brilliant friend who writes them up as case records. Each story moves from a client's strange tale to a lightning deduction drawn from small physical traces, with a dramatic reveal and a calm explanation at the end. The clubbable Victorian voice brings gaslit London and lonely moors to life.",
    traits: {
      narration:
        "Narrate in first person as the admiring sidekick, a sensible professional man who writes up past cases, cannot quite follow the genius beside him, and shares his surprise with the reader.",
      sentences:
        "Write courteous, well-formed Victorian sentences, moderately long and very clear. Keep the voice steady, grounded and slightly formal, even when things turn frightening.",
      diction:
        "Use late-Victorian English with professional terms from medicine and the law, along with period forms of address. Let the genius use exact scientific terms that outstrip the narrator's.",
      dialogue:
        "Make the great scene a client's long statement, then a rapid exchange in which the detective shows off by inferring the visitor's trade and recent movements from small marks.",
      description:
        "Fix the setting quickly with fog, cabs, lodgings and country houses. Describe physical evidence such as ash, mud, footprints and a worn sleeve with exact attention, because it will be used.",
      pacing:
        "Use a set structure: the domestic opening, the client's visit, a brief investigation, a trap or night watch, then the explanation of how every deduction was made.",
      signature:
        "Show a chain of deductions from trivial physical traces, delivered with cool theatricality and then explained as simple. Contrast the cold reasoning machine with the warm friend who tells it.",
      avoid:
        "Avoid modern slang, forensic labs, love plots at the center and deductions the reader could not trace back to a visible clue. The narrator must never be cleverer than the detective.",
    },
  },
  {
    id: 'michael-connelly',
    name: 'Michael Connelly',
    genres: ['crime', 'mystery', 'thriller'],
    knownFor: ['The Black Echo', 'The Lincoln Lawyer', 'The Poet'],
    summary:
      "Connelly writes modern police procedurals with a reporter's accuracy: real streets, case-file routines, interdepartmental politics. A dogged, solitary investigator follows the paperwork of old murders, driven by a moral insistence that every victim counts. The prose is clean and unshowy, and its momentum comes from one lead turning into the next while bureaucracy pushes back.",
    traits: {
      narration:
        "Stay in a tight third or first person on one stubborn investigator, following only what he learns and what he suspects about his own department.",
      sentences:
        "Write clear, plain, unadorned sentences of moderate length, with a newspaperman's economy. Let the mood come from facts and a quiet, tired voice.",
      diction:
        "Use authentic police and courtroom jargon, unit names and form numbers, explained quickly or by context. Name actual Los Angeles roads, neighborhoods and landmarks.",
      dialogue:
        "Write realistic work talk among detectives, supervisors and defense lawyers, with resentment and turf defended in dry, guarded lines. Let interviews show a slow, patient technique.",
      description:
        "Show the case file: the murder book, what a report leaves out, an old photo, a storage box. Describe the city from behind a windshield or from a hillside at night.",
      pacing:
        "Advance one step at a time, with each small lead opening the next. Add internal-affairs or political pressure on the hero, and spring a late reversal showing that the case reached closer to home.",
      signature:
        "Show the tedious craft of investigation as the source of suspense, with old cases reopened and a small overlooked detail in the paperwork. Let a personal code make the detective a problem for his own bosses.",
      avoid:
        "Avoid flashy serial-killer theatrics without procedure, lush prose and easy forensics. The answer should never appear without legwork.",
    },
  },
  {
    id: 'ian-rankin',
    name: 'Ian Rankin',
    genres: ['crime', 'mystery'],
    knownFor: ['Knots and Crosses', 'Black and Blue', 'Exit Music'],
    summary:
      "Rankin writes Scottish police novels with Edinburgh as a split-personality character, a tourist city above and a hard one below. His middle-aged detective is stubborn, drinks too much, plays old rock records and clashes with his superiors. Dry Scots humor runs under the procedure, and the crimes spread into politics, money and the past.",
    traits: {
      narration:
        "Use close third on a stubborn, aging inspector, with a sardonic interior voice, a heavy record collection and a habit of going off on his own.",
      sentences:
        "Write brisk, unfussy sentences with a dry, downbeat rhythm. Let a wry short remark close a paragraph of plain police routine.",
      diction:
        "Use Scots idiom and police slang in a natural way, along with pub and music references. Keep the wording lean and salted with understatement.",
      dialogue:
        "Write sharp, sarcastic talk among cops, villains and old enemies, with Scottish cadence and affectionate insult. Let a long-running rivalry with a local gangster bring out grudging respect.",
      description:
        "Show the city's double life, its old stone and tourists against housing schemes and backroom deals, in real streets and pubs. Mention weather and hangovers more than scenery.",
      pacing:
        "Run multiple cases that seem unrelated until they join. Slow down for pub conversations and record-listening, and let the hero be suspended or sidelined on his way to the truth.",
      signature:
        "Use the city's public face and hidden life as a mirror for the case. Let an old unsolved matter resurface and connect to the powerful, while a dry pub joke deflates the gravity.",
      avoid:
        "Avoid tidy justice, sanitized police work and a tourist-brochure Scotland. Do not make the detective a team player or a saint.",
    },
  },
  {
    id: 'tana-french',
    name: 'Tana French',
    genres: ['crime', 'mystery', 'literary'],
    knownFor: ['In the Woods', 'The Likeness', 'Faithful Place'],
    summary:
      "French writes long, atmospheric, psychologically dense crime novels in the first person, narrated by a member of a Dublin murder squad who has an unhealed connection to the case. The solution matters less than what it costs the narrator. Lush, confiding prose, Irish speech and intense interrogations build toward an ending that often leaves part of the mystery open and the narrator damaged.",
    traits: {
      narration:
        "Use a retrospective, seductive first person from a detective who warns the reader they are not trustworthy. Let their past wound color each judgment, and let the wound blind them.",
      sentences:
        "Write long, musical, confessional sentences with Irish cadence, broken up by sudden colloquial remarks. Let reflection linger over a moment of memory or dread.",
      diction:
        "Blend literary, sensory language with salty Dublin slang and police talk. Keep metaphors tied to memory, woods, houses and the fading of childhood.",
      dialogue:
        "Stage long interrogation scenes in which a detective plays roles and adjusts their accent to win a suspect's trust. Let partners banter with deep intimacy that can turn on them.",
      description:
        "Make the place press on the people: housing estates, forests, an old family street, summer dusk. Use rich sensory atmosphere to carry memory and unease.",
      pacing:
        "Take a slow, immersive approach, with interviews and quiet domestic moments. Let the narrator's personal crisis grow alongside the case, and make the final confession as much emotional as factual.",
      signature:
        "Make solving the crime cost the detective their closest bond and their idea of themselves. Leave one piece of the mystery forever unsolved so it continues to haunt.",
      avoid:
        "Avoid brisk plot-only chapters, heroic detectives and everything tied up. Don't let the narrator seem reliable about their own motives.",
    },
  },
  {
    id: 'elmore-leonard',
    name: 'Elmore Leonard',
    genres: ['crime', 'thriller', 'western'],
    knownFor: ['Get Shorty', 'Out of Sight', 'Rum Punch'],
    summary:
      "Leonard writes crime stories almost entirely through the way people talk: cool, funny, foolish criminals and marshals whose schemes collide. The narration disappears into each character's voice, so that a paragraph reads the way that person thinks. Plots grow from character rather than design, and the writing cuts anything a reader would skip.",
    traits: {
      narration:
        "Use a close third that takes on each character's voice and grammar, including the fools and the killers. Let the narrator vanish and treat every criminal's self-image seriously.",
      sentences:
        "Write loose, conversational sentences that drop subjects and auxiliary verbs, using participles as people do when thinking aloud. Avoid semicolons and any literary polish.",
      diction:
        "Use ordinary American speech and street vernacular, with small comic mispronunciations and misused terms. Avoid adverbs and fancy words, and use 'said' for nearly every speech tag.",
      dialogue:
        "Make dialogue the whole show: oblique, overlapping, funny talk that reveals who a person thinks they are. Start the scene late and let them talk about something else on the way to the point.",
      description:
        "Keep description minimal and in the character's terms: what a person notices about a car or a jacket. Skip weather and scenery unless a character has an opinion on them.",
      pacing:
        "Let plots emerge from what each character wants, with schemes going wrong through stupidity and vanity. Cut between crooks and law at scene length, entering late and leaving early.",
      signature:
        "Let a cool professional and a dim, dangerous amateur share a scheme, and let the comedy of their overconfidence drive the plot. Show violence abruptly and casually, in the middle of chat.",
      avoid:
        "Avoid long descriptions, narrated explanations, exclamation points and elaborate speech tags. Rewrite any line that calls attention to the author.",
    },
  },
  {
    id: 'james-ellroy',
    name: 'James Ellroy',
    genres: ['crime', 'historical'],
    knownFor: ['The Black Dahlia', 'L.A. Confidential', 'American Tabloid'],
    summary:
      "Ellroy writes crime fiction in a telegraphic, hyperkinetic style of fragments, alliteration and period slang, as if the prose itself were on amphetamines. Police, fixers and gossip sheets tangle in postwar corruption, with real history running behind invented sins. Interior monologue, faked documents and pulp headlines pile up into an obsessive, feverish secret history.",
    traits: {
      narration:
        "Use several obsessed, compromised men in close third or first person, whose voices are almost pure compulsion and who narrate their own rotten bargains.",
      sentences:
        "Cut articles and verbs to leave staccato fragments, with one idea per clause. Use repeated structures, alliteration and sudden lists, so the rhythm hammers.",
      diction:
        "Pack the prose with vintage police and tabloid slang, period insults and invented nicknames for people. Prefer harsh, alliterative compounds, and keep the tone tabloid-loud.",
      dialogue:
        "Write hard, ugly, overlapping cop and hoodlum talk, with blackmail and shakedowns stated in shorthand. Keep lines brief, and make every exchange a negotiation.",
      description:
        "Reduce scenes to burst snapshots: a neon sign, a stained shirt, a mug shot, a rap sheet. Interrupt with police reports, wire transcripts and gossip columns.",
      pacing:
        "Run parallel investigations through massive conspiracies, with scenes as short as a paragraph. Accelerate toward a bloodbath in which each man's obsession ruins him.",
      signature:
        "Interleave invented documents with narrative to build a secret history of an era's corruption. Let the fragmentary style tighten further and further as the characters lose control.",
      avoid:
        "Avoid long, graceful sentences, reflective calm and heroes with clean hands. Do not explain the slang or let the rhythm relax for long.",
    },
  },
  {
    id: 'sue-grafton',
    name: 'Sue Grafton',
    genres: ['mystery', 'crime'],
    knownFor: ['"A" Is for Alibi', '"B" Is for Burglar', '"K" Is for Killer'],
    summary:
      "Grafton's alphabet series is told by a twice-divorced California private investigator who writes up each case as a report: self-deprecating, curious and fond of her own routines. The pleasures are the voice, the small-town 1980s setting and an accumulating everyday detail. Investigation proceeds by knocking on doors and reading records, with a dry feminist humor running through it.",
    traits: {
      narration:
        "Use a chatty first person from an independent woman detective, who introduces herself to the reader at the start of each book and frames events as her report on the case.",
      sentences:
        "Write relaxed, conversational sentences with a wry finish. Let digressions about her finances or diet sit in the middle of the investigation.",
      diction:
        "Use plain American English with a dry, self-mocking tone. Keep police and insurance terms simple, and let period details stay accurate, with no internet to solve anything.",
      dialogue:
        "Write realistic interviews with landlords, clerks and ex-spouses, who talk longer than they should. Let the detective get information through patience and small lies.",
      description:
        "Note what people wear, eat and live in with a shrewd, slightly comic eye, including the detective's own thrift and small domestic habits. Describe the California town plainly.",
      pacing:
        "Move through door-knocking, index cards and record searches at an even pace, with domestic interludes. Then let the danger arrive quickly in a sharp, solitary final confrontation.",
      signature:
        "Bracket the story as a signed, professional case report, and fill it with mundane routines that make the sudden danger shocking. Let the heroine's solitude be both her freedom and her weakness.",
      avoid:
        "Avoid glamour, supermen, high-tech shortcuts and a heroine who is never scared. Do not skip the boring legwork; the voice makes it enjoyable.",
    },
  },
  {
    id: 'janet-evanovich',
    name: 'Janet Evanovich',
    genres: ['mystery', 'crime', 'humor', 'romance'],
    knownFor: ['One for the Money', 'Two for the Dough', 'Three to Get Deadly'],
    summary:
      "Evanovich writes screwball crime comedy through a bumbling but game bail enforcement agent from working-class New Jersey. The narrator's cars keep getting blown up, her family is loudly intrusive, and two attractive men complicate everything. Plots are light and quick, and the point is the comic voice, the neighborhood color and the running gags that readers return for.",
    traits: {
      narration:
        "Use a self-deprecating, chatty first-person heroine who is out of her depth at her own job and tells the reader frankly what went wrong this time.",
      sentences:
        "Write short, breezy sentences that set up a joke and hit it fast. Keep paragraphs brief and the rhythm like someone telling a funny story at the kitchen table.",
      diction:
        "Use blue-collar, regional American speech, with food and junk-brand details, mild swearing and casual sexual humor. Keep the jokes plain and warm.",
      dialogue:
        "Write rapid comic exchanges with a nosy mother, a shameless older relative, a loud coworker and two flirting love interests. Let everyone interrupt everyone.",
      description:
        "Sketch the neighborhood through hair, doughnuts, funeral homes and big-city traffic. Describe mishaps with garbage, dogs and explosions in plain comic detail.",
      pacing:
        "Move quickly through a chain of failed captures, family dinners and car disasters, while a light mystery ticks underneath. Close with a lucky, chaotic catch.",
      signature:
        "Stack running gags across the books: a vehicle destroyed every time, a family dinner she can't escape, and a romantic stalemate that never resolves. Let the heroine win by stubbornness and luck.",
      avoid:
        "Avoid grim procedure, brooding, gore on the page and a heroine who is good at her job. Don't let a chapter pass without a laugh.",
    },
  },
  {
    id: 'dorothy-l-sayers',
    name: 'Dorothy L. Sayers',
    genres: ['mystery', 'crime', 'classics'],
    knownFor: ['Whose Body?', 'Gaudy Night', 'The Nine Tailors'],
    summary:
      "Sayers writes intelligent golden-age detective novels with a learned, witty aristocrat at their center and a real interest in the world each crime takes place in. A whole subject, such as bell ringing, advertising or academic life, is researched and made part of the plot. Later books grow into serious novels of manners about work, conscience and an equal marriage of minds.",
    traits: {
      narration:
        "Use an urbane third person with a taste for literary allusion, staying by turns with a witty amateur sleuth and with a thoughtful, independent woman whose judgment matters as much as his.",
      sentences:
        "Write educated, elegant, somewhat long English sentences with dry wit. Allow Latin tags and quotations in a learned character's mouth, used for comedy.",
      diction:
        "Use a rich interwar British vocabulary, with precise terms of the trade or subject the mystery is built around, explained with enthusiasm.",
      dialogue:
        "Write sparkling, allusive banter that hides real feeling, with a chattering upper-class manner as cover for a serious mind. Give working people and servants well-observed speech.",
      description:
        "Describe a craft, institution or place in loving, expert detail, since the solution will depend on it. Note class, food and wine with a connoisseur's eye.",
      pacing:
        "Allow time for manners, side characters and the study of the setting, and let the clue-puzzle unfold alongside moral questions. Let the solution leave a real cost behind.",
      signature:
        "Build the plot on real expertise in an unusual subject, so that the reader learns a whole world along the way. Use the mystery to ask what honest work and integrity require.",
      avoid:
        "Avoid thin puzzle-only plotting, gore, American hardboiled idiom and shallow settings. Do not pretend the detective is unaffected by sending someone to the gallows.",
    },
  },
  {
    id: 'walter-mosley',
    name: 'Walter Mosley',
    genres: ['crime', 'mystery', 'historical', 'literary'],
    knownFor: ['Devil in a Blue Dress', 'A Red Death', 'Little Scarlet'],
    summary:
      "Mosley writes hardboiled mysteries set in Black Los Angeles from the postwar years onward, through a homeowner and reluctant investigator who has to navigate white police and his own community. The plain, musical voice observes race and class in every room. A dangerous friend, debts of honor and the changing city carry as much weight as the crime itself.",
    traits: {
      narration:
        "Use a thoughtful first person from a Black working man who takes odd jobs for people who can't go to the police, and who is always reading what each person in the room assumes about him.",
      sentences:
        "Write simple, rhythmic, conversational sentences with a blues cadence. Let a plain observation close a paragraph with quiet force.",
      diction:
        "Use period vernacular of Southern migrants in Los Angeles alongside the narrator's more guarded standard speech, and change register depending on who is listening.",
      dialogue:
        "Show code-switching: how a person speaks to white officials differs sharply from how he speaks at a barbershop or with old friends from home. Let talk carry menace and warmth together.",
      description:
        "Observe neighborhoods precisely: lawns, bars, boarding houses, the color line on each street. Let the pride of owning a small house weigh as much as any clue.",
      pacing:
        "Move by visits and conversations through the neighborhood, with one lead pulling the hero into something bigger than he wanted. Let a violent friend's help cost more than the problem.",
      signature:
        "Make race the constant pressure on each simple act of investigation, and treat a place's history as the true mystery. Give the narrator a dangerous, loyal friend whose violence he must answer for.",
      avoid:
        "Avoid colorblind settings, cartoon gangsters, lyrical excess and a hero with official power. Do not let the crime matter more than the community it touches.",
    },
  },
  {
    id: 'louise-penny',
    name: 'Louise Penny',
    genres: ['mystery', 'crime'],
    knownFor: ['Still Life', 'A Fatal Grace', 'The Beautiful Mystery'],
    summary:
      "Penny writes warm, humane Quebec village mysteries in which a thoughtful chief inspector solves murders by listening and caring about people. The narration moves freely among many heads in a scene, in short sentences and even shorter fragments set off as paragraphs. Good food, an eccentric group of villagers and long-buried pain matter more than forensics.",
    traits: {
      narration:
        "Use a warm third person that moves among several minds within a single scene, so that the reader overhears the private doubts of a detective and of each villager.",
      sentences:
        "Write simple sentences, then interrupt them with short fragments set off as their own paragraphs. Repeat a phrase or a line of poetry as a gentle refrain.",
      diction:
        "Use plain, kindly, slightly literary language, with French phrases from Quebec, and specific food, wood stoves and seasons. Let characters' love of a favorite poem surface now and then, in passing.",
      dialogue:
        "Write friendly, teasing talk around a shared table among eccentric locals who insult each other with love. Let a quiet question from the inspector open a person up.",
      description:
        "Linger on village comforts: fires, croissants, snow on a green, a bookshop. Let the beauty of the place sit next to the fact that someone there has killed.",
      pacing:
        "Unfold slowly, in conversations and meals, with police office politics in the background. Solve the crime by understanding what shame or love drove it, and end with mercy rather than triumph.",
      signature:
        "Set a kindly, wise detective among villagers who are also his friends, and make the solution a matter of emotional truth. Use a recurring saying or poem as the book's moral compass.",
      avoid:
        "Avoid gore, gritty cynicism, high-tech forensics, and a cold or lone detective. Do not let the village lose its warmth, even when someone in it is guilty.",
    },
  },
  {
    id: 'richard-osman',
    name: 'Richard Osman',
    genres: ['mystery', 'crime', 'humor'],
    knownFor: ['The Thursday Murder Club', 'The Man Who Died Twice', 'The Bullet That Missed'],
    summary:
      "Osman writes cheerful modern cozy mysteries about pensioners in a retirement village who solve murders with experience and shameless nerve. Very short chapters hop across a large cast, broken up by one character's chatty first-person diary. The comedy is gentle, the plot truly intricate, and a seam of honest feeling about age, love and loss runs beneath the jokes.",
    traits: {
      narration:
        "Mix a sly, amused present-tense third person that hops among many characters with chatty first-person diary entries from a sweetly sharp older woman.",
      sentences:
        "Write short, friendly, conversational sentences with deadpan punchlines. End many chapters on a small comic or mysterious note.",
      diction:
        "Use contemporary, gently comic British English, with cakes, parking and retirement activities treated seriously. Let older characters' surprising pasts show in their vocabulary.",
      dialogue:
        "Write teasing exchanges among very different old friends, and let polite elderly people run rings around police officers and criminals.",
      description:
        "Keep description quick and comic, picking out the small domestic detail that a nosy neighbor would. Treat a body in the same mild tone as a dispute over the bowling club.",
      pacing:
        "Use extremely short chapters that hop viewpoint, and keep two or three plots going until they join. Turn to sudden quiet moments about illness or widowhood before the comedy returns.",
      signature:
        "Let the underestimated elderly outwit everyone by using their pasts and the fact that nobody notices them. Pivot from a joke to a moment of real sorrow, with no warning and no fuss.",
      avoid:
        "Avoid gore, grim detectives, cynicism about old age and slow chapters. Don't make the old people cute or helpless.",
    },
  },
];
