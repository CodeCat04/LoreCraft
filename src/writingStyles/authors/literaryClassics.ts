import type { AuthorData } from '../types';

export const LITERARY_CLASSICS: AuthorData[] = [
  {
    id: 'j-d-salinger',
    name: 'J.D. Salinger',
    genres: ['literary', 'classics'],
    knownFor: ['The Catcher in the Rye', 'Franny and Zooey', 'Nine Stories'],
    summary:
      "Salinger writes in the rhythms of spoken American talk, so a page feels overheard rather than composed. His narrators are bright, wounded and allergic to falseness, circling a grief they will not name directly. Small encounters with children, taxi drivers and old teachers carry the weight, and the humor is a defense that keeps slipping.",
    traits: {
      narration:
        "Use a confiding first-person young narrator who digresses constantly and avoids the one subject that hurts until it leaks out sideways.",
      sentences:
        "Write loose, run-on spoken sentences that restart themselves, with verbal tics as rhythm. Italicize single words to mark spoken stress.",
      diction:
        "Use period teen slang and mild profanity, with one or two pet intensifiers that recur on every page. Let an educated kid's vocabulary surface and then get mocked by the speaker.",
      dialogue:
        "Write conversations that miss each other: people repeat questions, interrupt, and make small talk while something urgent goes unsaid. Render exact pauses and emphasis, so that a phone call becomes a tiny drama.",
      description:
        "Notice small, embarrassing, tender details such as a chewed fingernail, a worn suitcase or a child's coat. Filter every room through the narrator's opinion of the people in it.",
      pacing:
        "Let plot be slight: a few aimless days, one encounter after another, with memories interrupting. Build pressure through what the narrator keeps swerving away from, and end on a quiet, unresolved image.",
      signature:
        "Let a child's unguarded remark or gesture break through the narrator's sarcasm and undo them. Treat spotting falseness in others as a compulsion that the narrator suspects is also a symptom.",
      avoid:
        "Avoid polished literary sentences, stated epiphanies and tidy therapy-speak. The narrator must never explain what the grief means or sound like an adult who has recovered.",
    },
  },
  {
    id: 'jack-kerouac',
    name: 'Jack Kerouac',
    genres: ['literary', 'classics'],
    knownFor: ['On the Road', 'The Dharma Bums', 'Big Sur'],
    summary:
      "Kerouac writes autobiographical road novels in long, breathless bursts modeled on jazz improvisation, chasing the feeling of a moment before it fades. The narrator is an admiring, restless follower, drunk on American place names and the people he meets along the way. Joy and exhaustion alternate, and the comedown is as much the subject as the high.",
    traits: {
      narration:
        "Use a wide-eyed first-person traveler who hero-worships a wilder friend and tells it as if recounting the trip the morning after, sentimental, half-ashamed and still thrilled.",
      sentences:
        "Write long, rushing sentences strung on and, dashes and commas, like a saxophone solo. Let them burst into a shout of praise, then drop to a tired flat line.",
      diction:
        "Mix hipster and hobo slang of the period with Catholic and Buddhist words, and spontaneous adjectives doubled up for feeling. Chant real town names and highway numbers as if they were poetry.",
      dialogue:
        "Write manic monologues from a fast-talking friend who never finishes a thought, while the narrator listens and adores. Let waitresses and truckers speak plain regional American.",
      description:
        "Sweep across the continent in lists: diners, freight yards, plains at dusk, neon, pie and coffee. Describe a jazz club by the music's physical frenzy rather than by what it looks like.",
      pacing:
        "Structure the book as a sequence of departures and arrivals, each trip starting in hope and ending broke and sick. Skip thousands of miles in a paragraph, then spend pages on one night.",
      signature:
        "Break into ecstatic, near-religious riffs about the American night and its lost people, then crash. Let the idolized friend slowly let everyone down.",
      avoid:
        "Avoid careful plotting, restrained prose, ironic distance and neat conclusions. Never edit the breath out of a sentence.",
    },
  },
  {
    id: 'gabriel-garcia-marquez',
    name: 'Gabriel García Márquez',
    genres: ['literary', 'classics'],
    knownFor: ['One Hundred Years of Solitude', 'Love in the Time of Cholera', 'Chronicle of a Death Foretold'],
    summary:
      "García Márquez narrates impossible events in the unblinking tone of a grandmother reporting town news, so that miracles and bureaucracy sit side by side. Long, looping sentences compress years and generations, and the narrator knows what will happen to everyone long before it does. Time circles back, families repeat themselves, and a matter-of-fact exactness makes the marvelous credible. As read in English translation, the music stays in the long paragraphs.",
    traits: {
      narration:
        "Use a deadpan communal storyteller who knows past and future and reports a miracle as calmly as a price rise. No one in the town stays amazed for long.",
      sentences:
        "Write long, winding sentences that carry a whole life in clauses, and paragraphs that run for pages with little dialogue. Announce a future event in passing, then return to the present.",
      diction:
        "Use plain, sensual, unhurried language, with oddly exact numbers attached to the impossible. Keep the register of oral gossip and family legend, never of genre fantasy.",
      dialogue:
        "Use very little direct speech, reporting most talk within the narration. Let a rare flat remark land as a verdict the town repeats for years.",
      description:
        "Attach one exact, physical, faintly absurd detail to each marvel. Treat heat, rot, flowers and old age with the same lush attention.",
      pacing:
        "Move by summary across decades, slowing only for a set piece. Tell the reader in the first line how something ends, and let suspense come from how it became unavoidable.",
      signature:
        "Report the supernatural as ordinary and the ordinary as astonishing. Give repeating names and repeating fates to successive generations, so that history feels like a circle a family cannot leave.",
      avoid:
        "Avoid explaining the magic, whimsy for its own sake, short snappy scenes and modern irony. No character should stop to question whether a miracle could really happen.",
    },
  },
  {
    id: 'vladimir-nabokov',
    name: 'Vladimir Nabokov',
    genres: ['literary', 'classics'],
    knownFor: ['Lolita', 'Pale Fire', 'Speak, Memory'],
    summary:
      "Nabokov writes dazzling, playful English in which the surface of the prose is itself the event: alliteration, puns across languages, and images of microscopic exactness. His narrators are vain, brilliant and unreliable, seducing the reader with style while the facts betray them. The book works as a game between author and reader, with clues planted for the attentive.",
    traits: {
      narration:
        "Use a florid, self-regarding first-person performer who pleads his case to the reader and is lying, often to himself. Let attentive readers catch what the elegant voice is trying to hide.",
      sentences:
        "Write elaborately balanced sentences that sound like a virtuoso showing off, using alliteration, assonance and sudden parentheses. Finish a long, perfumed sentence with a brief, cruel aside.",
      diction:
        "Reach for rare, exact words from entomology, chess and several languages, and pun across them. Prefer the surprising precise word to the expected good one, and enjoy its sound.",
      dialogue:
        "Let dialogue be brief and comic next to the narrator's grand prose, capturing banal speech with a collector's disdain. Show ordinary people through their clichés, as pinned specimens.",
      description:
        "Render the quality of light on a surface, a shadow's color or a moth's wing with minute, surprising accuracy. Describe commercial tackiness and motel kitsch with fastidious comic relish.",
      pacing:
        "Let style and memory set the tempo, circling a lost past, with plot revealed in casual asides and parentheses. Withhold or bury the worst event inside a subordinate clause.",
      signature:
        "Build the text as a puzzle: recurring motifs, anagrams, doubled figures and clues pointing to a truth the narrator denies. Make beauty of language the means by which the reader is implicated.",
      avoid:
        "Avoid plain functional prose, psychological cliché, open moralizing and social messages. Never settle for a stock image.",
    },
  },
  {
    id: 'kazuo-ishiguro',
    name: 'Kazuo Ishiguro',
    genres: ['literary'],
    knownFor: ['The Remains of the Day', 'Never Let Me Go', 'An Artist of the Floating World'],
    summary:
      "Ishiguro writes restrained first-person narrators whose politeness hides the ruin of their lives. They circle a memory, correct themselves and insist nothing much was wrong, and the reader slowly understands what they cannot admit. Calm, gray, courteous prose makes the eventual emotional blow enormous, even when nothing dramatic happens on the page.",
    traits: {
      narration:
        "Use a dignified first-person narrator recalling the past, who is mistaken about what mattered. Let them qualify memories, doubt the details, and defend decisions no one has criticized.",
      sentences:
        "Write even, courteous, slightly formal sentences that hedge: perhaps, it may be that, I believe. Keep the same mild tone for trivia and heartbreak, with no change of volume.",
      diction:
        "Use modest, plain, careful vocabulary without figurative flourish. Use a profession's euphemisms and manners as armor, so that the narrator's word for a thing hides what it really is.",
      dialogue:
        "Write polite exchanges full of deflection, in which what matters goes unsaid. Let someone gently state the truth, and let the narrator hurry past it.",
      description:
        "Give only the plain facts of a room, an afternoon's weather, a road through a countryside, as a memory might keep them. Let a remembered small object carry disproportionate feeling.",
      pacing:
        "Advance slowly with digressions into memory, frequently returning to the same incident with a slight correction. Save a quiet late scene in which the narrator nearly admits everything, then retreats.",
      signature:
        "Let the gap between what the narrator says and what the reader understands be the entire drama. Show someone deciding, after it is too late, to go on as if nothing was lost.",
      avoid:
        "Avoid outbursts, confessions, melodramatic twists and lyrical emotional description. The narrator must never fully say what happened to them.",
    },
  },
  {
    id: 'leo-tolstoy',
    name: 'Leo Tolstoy',
    genres: ['literary', 'classics', 'historical'],
    knownFor: ['War and Peace', 'Anna Karenina', 'The Death of Ivan Ilyich'],
    summary:
      "Tolstoy writes in a clear, unhurried omniscient voice that moves effortlessly between private thought and public history. He notices the small physical gesture that betrays a person's real feeling, and treats a battlefield and a dinner party with equal attention. Long passages test what people claim to believe against what they actually do, and the narrator will stop the story to argue a point.",
    traits: {
      narration:
        "Use a calm omniscient narrator able to enter any mind within a scene, even an animal's. Show the distance between what a character thinks they feel and what they are really feeling.",
      sentences:
        "Write long, plain, firmly constructed sentences with repeated words and few ornaments. Use conjunctions to stack observations, and aim for clarity rather than elegance.",
      diction:
        "Use simple, exact, undecorated language, even for grand events. Let French phrases or rank titles mark aristocratic artifice, then expose it with a plain word for the same thing.",
      dialogue:
        "Write drawing-room talk that conceals motives, and interpret it in the narration: tell the reader what a glance or a false smile really said between two people.",
      description:
        "Return repeatedly to one small physical trait that identifies a person, like a signature, each time they enter. Show war through a confused individual's narrow view rather than as a commander's map.",
      pacing:
        "Shift across families and years, interleaving long domestic chapters with historical upheaval. Build slowly to sudden moral insight, often at the edge of death or birth.",
      signature:
        "Make the familiar strange by describing an opera, a court or a ritual as if seeing it for the first time. Interrupt with essays arguing that history is not moved by great men.",
      avoid:
        "Avoid plot tricks, irony for style's sake, fancy metaphors and heroic battle spectacle. Do not let any social ceremony pass unquestioned.",
    },
  },
  {
    id: 'fyodor-dostoevsky',
    name: 'Fyodor Dostoevsky',
    genres: ['literary', 'classics', 'crime'],
    knownFor: ['Crime and Punishment', 'The Brothers Karamazov', 'Notes from Underground'],
    summary:
      "Dostoevsky writes feverish novels of ideas in which people argue about God, guilt and freedom as if their lives depended on it, because they do. Characters burst into crowded rooms, confess, faint and contradict themselves in long, agitated speeches. Crime and scandal drive the plot, while the real action takes place inside a mind arguing against itself at the edge of breakdown.",
    traits: {
      narration:
        "Use a close, anxious third person or a gossipy narrator who is a townsman, sharing a character's racing self-justification. Let a first-person speaker defy and bait the reader, anticipating objections.",
      sentences:
        "Write nervous, headlong sentences, doubling back, repeating, and qualifying themselves with dashes and exclamations. Let the rhythm grow more frantic as a character's reasoning unravels.",
      diction:
        "Use intense, unstable language of shame, spite, suffering and faith, and mix philosophical terms with petty money worries. Lean on the words suddenly, strangely, almost and as if.",
      dialogue:
        "Write long confessional monologues and duels of ideas, in which each speaker wounds themselves too. Let a poor drunk or a magistrate talk for pages, circling the real point.",
      description:
        "Show cramped rented rooms, stifling heat, shabby clothes and sick faces. Let fever or sleeplessness distort the city, and show contradictory feeling fighting on a face.",
      pacing:
        "Compress days into crisis, with sudden visitors and scandal scenes where everyone arrives at once. Follow catastrophe with long aftermath, as a patient investigator torments a suspect.",
      signature:
        "Pit a coldly reasoned theory against the body and conscience of the person who holds it. Let a character confess or humiliate themselves in public out of pride, and let opposite feelings exist together.",
      avoid:
        "Avoid calm, understated realism, tidy moral lessons from the narrator and bland, sane people. Let no one simply say what they mean without fighting themselves first.",
    },
  },
  {
    id: 'herman-melville',
    name: 'Herman Melville',
    genres: ['literary', 'classics'],
    knownFor: ['Moby-Dick', 'Billy Budd', 'Bartleby, the Scrivener'],
    summary:
      "Melville writes huge, restless, encyclopedic prose that swings between a sailor's comedy and Shakespearean thunder. A voyage becomes an excuse for digressions on every aspect of a trade, each one turning into metaphysics. Chapters change form freely, into stage scenes, sermons and catalogues, and the narrator's wandering, sociable curiosity plays against a monomaniac's fixed purpose.",
    traits: {
      narration:
        "Use a genial, philosophizing first-person sailor who addresses the reader in a friendly way, then forgets himself and claims knowledge of scenes he could not have witnessed.",
      sentences:
        "Write long, rolling, biblical periods with piled clauses and semicolons, alternating with sudden salty jokes. Let an ordinary observation swell into a cosmic question within one paragraph.",
      diction:
        "Combine exact nautical and trade vocabulary with King James and Shakespearean grandeur, along with coined compound words. Let high rhetoric and low humor sit side by side.",
      dialogue:
        "Give a captain or a preacher grandiloquent speeches in archaic cadences, and sailors earthy comic exchanges. Occasionally set out a scene as a stage play, with speakers and directions.",
      description:
        "Explain a trade exhaustively: the tools, anatomy, procedures and history of the work. Treat each physical fact as a symbol waiting to be interpreted, and then interpret it at length.",
      pacing:
        "Delay the plot deliberately with chapters of pure digression and classification, while dread of the final confrontation builds in the background. Let the end be swift and total after long patience.",
      signature:
        "Turn a mundane piece of technical information into a meditation on fate and God. Vary the form of chapters as if the book itself cannot be contained by any one genre.",
      avoid:
        "Avoid economy, restraint, tight plotting and a single stable tone. Do not treat digressions as filler; they are the book.",
    },
  },
  {
    id: 'mark-twain',
    name: 'Mark Twain',
    genres: ['literary', 'classics', 'humor'],
    knownFor: ['Adventures of Huckleberry Finn', 'The Adventures of Tom Sawyer', 'A Connecticut Yankee in King Arthur\'s Court'],
    summary:
      "Twain writes American vernacular storytelling, in which an untutored voice sees through the hypocrisy of respectable people without quite realizing it. The humor comes from deadpan tall tales and a straight face. Regional dialects are carefully distinguished, and the river towns are full of frauds, feuds and small-town vanity, with real moral seriousness under the jokes.",
    traits: {
      narration:
        "Use a naive, plainspoken first-person boy or a dry folksy narrator, who reports the absurd conduct of adults with innocent approval. Let the reader see further than the speaker does.",
      sentences:
        "Write loose, rambling, spoken sentences linked with and, full of ungrammatical confidence, as if told on a porch. Build up slowly to a dry understatement that is the punchline.",
      diction:
        "Write in carefully observed regional dialect, spelled by ear, with misused big words and homespun comparisons. Mock high-flown romantic language by having a fool or a fraud employ it.",
      dialogue:
        "Distinguish each speaker's regional and class speech, and let con men, drunks and pious aunts talk themselves into comic corners. Let a long boastful yarn run without interruption.",
      description:
        "Describe the river and the weather with sudden plain beauty, in the speaker's own words, then return to shabby towns and their mud, hogs and loafers with cheerful contempt.",
      pacing:
        "Follow an episodic journey through one comic encounter after another, each exposing a different local foolishness. Let serious moral danger creep in under the episodes.",
      signature:
        "Tell an enormous lie with a perfectly straight face, and let an innocent voice condemn a whole society by earnestly approving of it. Burlesque the sentimental fiction of the day.",
      avoid:
        "Avoid genteel literary language, sermonizing, an obviously clever narrator and a knowing wink. The humor must never explain itself.",
    },
  },
  {
    id: 'harper-lee',
    name: 'Harper Lee',
    genres: ['literary', 'classics'],
    knownFor: ['To Kill a Mockingbird', 'Go Set a Watchman'],
    summary:
      "Lee tells a story of racial injustice through a grown woman's warm, witty memory of her tomboy childhood in a small Southern town. The double perspective lets the adult's irony sit inside the child's limited understanding. Neighbors, front porches and family manners are drawn with affectionate comedy, so that when the courtroom scenes arrive the whole community stands accused.",
    traits: {
      narration:
        "Use a first-person adult looking back on being a sharp, stubborn child, moving easily between what the child saw and what the woman now understands. Keep the voice affectionate and dry.",
      sentences:
        "Write relaxed, well-mannered sentences with a Southern lilt and gentle comic timing. Let an unhurried account of local history end in a wry remark.",
      diction:
        "Blend educated, slightly formal adult wording with a child's idiom and period small-town Southern phrases. Use grown-up terms as a child hears them, comically half-understood.",
      dialogue:
        "Give each neighbor a clear social voice marked by class and race, with sparring between a quick child and patient adults. Let a calm, courteous parent teach through plain questions.",
      description:
        "Build the town house by house: who lives where, whose family is known for what, heat, porches and school clothes. Treat family history as the town's explanation of character.",
      pacing:
        "Spend a long first stretch on seasons of childhood games and neighborhood legends, seeding small mysteries. Let a public crisis join these threads, and pay off an early oddity at the climax.",
      signature:
        "Show adult cruelty through a child's puzzled eyes, so that an innocent question exposes what the town will not say. Let someone the town fears or mocks prove unlike the legend.",
      avoid:
        "Avoid angry sermons, a child who understands too much, and gothic excess. Never let the public drama erase the comedy of everyday life.",
    },
  },
  {
    id: 'david-foster-wallace',
    name: 'David Foster Wallace',
    genres: ['literary', 'humor'],
    knownFor: ['Infinite Jest', 'The Pale King', 'Brief Interviews with Hideous Men'],
    summary:
      "Wallace writes maximalist, hyperarticulate fiction whose sentences try to account for everything a mind notices, including its noticing. Endnotes and footnotes branch away from the main text, and slang, jargon and bureaucratic language share one long breath. The comic excess serves a sincere concern with loneliness, addiction and the difficulty of paying real attention.",
    traits: {
      narration:
        "Use a hyperaware voice, in close third or first person, that monitors its own motives and worries about how it comes across. Slip into each character's idiom, including ungrammatical dialects.",
      sentences:
        "Write enormous, recursive sentences with nested qualifications, parentheses and abbreviations, then drop a tiny plain one. Start sentences with And or But, and use legalistic hedges alongside slang.",
      diction:
        "Mix medical, pharmaceutical and mathematical jargon with academic terms and casual filler such as sort of and like. Use odd acronyms, exact brand names and rare dictionary words deadpan.",
      dialogue:
        "Write long stretches of dialogue with few or no speech tags, using a bare ellipsis as someone's silent reply, and let people talk past each other in distinctive verbal tics.",
      description:
        "Catalog with obsessive completeness: every procedure, form, bodily sensation and piece of professional arcana. Let boredom and tedium be described so closely that they become gripping.",
      pacing:
        "Fragment the chronology, jump between many storylines, and leave the main events unresolved or hidden in notes. Spend pages on a small moment, and skip the climax entirely.",
      signature:
        "Add footnotes or endnotes that have footnotes of their own, carrying crucial plot or emotional content. Move from comic over-explanation to a sudden, nakedly sincere moment of pain.",
      avoid:
        "Avoid neat minimalism, cool irony as an end in itself, tidy plots and summary. Do not let cleverness stand in for caring.",
    },
  },
  {
    id: 'donna-tartt',
    name: 'Donna Tartt',
    genres: ['literary', 'thriller', 'mystery'],
    knownFor: ['The Secret History', 'The Little Friend', 'The Goldfinch'],
    summary:
      "Tartt writes long, immersive novels narrated by an outsider in thrall to a beautiful, doomed world, often revealing the central crime or catastrophe at the outset. The prose is rich, cultivated and patient, thick with objects, weather, drugs, drink and art. Tension comes from dread and intimacy rather than surprise, and a grand classical or Dickensian scale is applied to modern lives.",
    traits: {
      narration:
        "Use a retrospective first-person outsider who looks back with guilty longing on the people who seduced him. Announce the disaster early, and let him tell how he helped it happen.",
      sentences:
        "Write long, elegant, densely textured sentences with a measured, old-fashioned cadence. Let a slow-building paragraph land on a chilling plain sentence.",
      diction:
        "Use a learned, sensuous vocabulary of classics, antiques, painting and old money, along with accurate street and pharmaceutical slang. Treat a dead language or an old chair with a connoisseur's care.",
      dialogue:
        "Write witty, affected talk among brilliant, snobbish friends who conceal things from each other. Let manners hold even as guilt and paranoia grow.",
      description:
        "Spend pages on interiors, seasons and meals: cold air on a college campus, cigarette smoke, an old painting's surface. Let the beauty of things be part of what corrupts the narrator.",
      pacing:
        "Reveal the crime in the opening pages, then take hundreds of pages to reach it. Follow it with an even longer aftermath, in which fear, drink and mutual suspicion break the group apart.",
      signature:
        "Replace the question of who did it with why, and how could I have been part of it. Make the narrator's longing to belong the true motive for everything that goes wrong.",
      avoid:
        "Avoid brisk thriller prose, lean minimalism, a surprise-driven plot and clean redemption. Never hurry the long middle; the slow descent is the point.",
    },
  },
  {
    id: 'james-joyce',
    name: 'James Joyce',
    genres: ['literary', 'classics'],
    knownFor: ['Ulysses', 'Dubliners', 'A Portrait of the Artist as a Young Man'],
    summary:
      "Joyce follows ordinary people through ordinary hours and rebuilds the language around how their minds actually move. Narration bends toward each character's own vocabulary, thoughts arrive as unpunctuated fragments, and whole episodes imitate other styles of writing. The early stories are scrupulously plain and end on a quiet realization, while the later work turns every page into a performance of sound, puns and allusion.",
    traits: {
      narration:
        "Slide without warning between third-person observation and a character's unmarked thoughts. Let the narrator's language take on the words and vanity of whichever person it is near.",
      sentences:
        "Mix ordinary sentences with clipped, verbless thought fragments that jump by association. Let a passage shift into a long, unpunctuated flow when a mind drifts toward sleep.",
      diction:
        "Coin compound words, pun across languages and savor sound for its own sake. Use city slang, church Latin, advertising jingles and old-fashioned rhetoric in the same chapter.",
      dialogue:
        "Introduce speech with a dash instead of quotation marks. Write pub talk that is barbed, musical and evasive, with a person's standing decided by a joke.",
      description:
        "Fix the action on exact streets, shop names, timetables and smells of one real city, including bodily functions treated without embarrassment. Let trivial objects come back later, changed in meaning.",
      pacing:
        "Compress a huge book into a single day, or let a short story drift until one small event reveals a paralyzed life. Change style as episodes change.",
      signature:
        "Parody a different prose style for each section, and set a modern ordinary day against an ancient template. End a plain story on a quiet flash of insight the character can barely bear.",
      avoid:
        "Avoid conventional plot hooks, tidy authorial explanation and squeamishness about the body. Do not translate the allusions or stop to help the reader catch up.",
    },
  },
  {
    id: 'franz-kafka',
    name: 'Franz Kafka',
    genres: ['literary', 'classics'],
    knownFor: ['The Trial', 'The Metamorphosis', 'The Castle'],
    summary:
      "Kafka reports nightmares in the sober prose of an insurance clerk. An unexplained accusation or transformation is accepted almost at once, and the protagonist spends the rest of the story pleading with officials, landlords and relatives who operate by rules nobody can state. Clear, careful, legalistic sentences make the absurd feel inescapable, and the comedy and the dread are impossible to separate.",
    traits: {
      narration:
        "Stay in a plain third person fixed to a single reasonable man, who sees only what he sees and never gets the overview. Treat the impossible premise as a fact from the first sentence.",
      sentences:
        "Write lucid, careful sentences that keep qualifying themselves, setting out one objection after another. Allow unbroken paragraphs that run for pages.",
      diction:
        "Use dry, official vocabulary: petition, authority, hearing, superior. Stay away from words of horror or marvel, and keep the same neutral register for humiliation as for filing.",
      dialogue:
        "Write lengthy, courteous speeches by minor officials who explain the system's logic and leave the hero worse off than before. Let any answer raise several new questions.",
      description:
        "Describe stuffy attics, cramped offices and endless corridors, with precise and pointless details of furniture. Note the odd behavior of assistants and onlookers as normal.",
      pacing:
        "Open with the catastrophe, then proceed in circles through interviews and waiting rooms, in which every apparent progress leads nowhere. Deny the ending a resolution, or let it fall abruptly.",
      signature:
        "Show a vast, unreachable authority through its lowest and most tired servants. Let the hero argue with perfect logic within a system that has no logic, and start to accept his own guilt.",
      avoid:
        "Avoid explaining the premise, naming the symbol, and overt surrealist decoration. No one should be surprised, and the system must never be defeated or fully seen.",
    },
  },
  {
    id: 'oscar-wilde',
    name: 'Oscar Wilde',
    genres: ['literary', 'classics', 'humor', 'gothic'],
    knownFor: ['The Picture of Dorian Gray', 'The Importance of Being Earnest', 'The Happy Prince and Other Tales'],
    summary:
      "Wilde writes scintillating epigrams spoken by people who treat seriousness as bad manners. Polite society is turned upside down through inversions, in which a truism is flipped and comes out truer. His prose is ornate, perfumed and aesthetic, and his comedies run on elegant nonsense, while his tales and his one novel carry a real moral chill beneath the sparkle.",
    traits: {
      narration:
        "Use a polished, urbane narrator who admires beauty and watches society with amused detachment, staying out of the way so that talk can dominate.",
      sentences:
        "Build balanced sentences that turn on a paradox, reversing the expected second half of a commonplace. Let descriptive passages run long and jeweled, with a slow, languid cadence.",
      diction:
        "Use refined drawing-room English and aesthetic vocabulary: lacquer, jade, perfume, silk, orchids. Treat trivial matters with enormous gravity, and grave matters with a shrug.",
      dialogue:
        "Make conversation a contest of invented epigrams, in which a languid aristocrat states outrageous opinions as obvious truths. Let everyone speak better than real people do, and never directly answer.",
      description:
        "Describe rooms and objects as an aesthete would catalog a collection, in rich color and scent. Give a beautiful surface a hint of something corrupt behind it.",
      pacing:
        "Let long scenes of witty talk substitute for action, with a plot of secrets, mistaken identities and social disgrace. Let the ending snap shut in sudden reversal or punishment.",
      signature:
        "Invert a pious truism so neatly that it sounds wiser than the original. Let the lightest speaker in the room say the most devastating thing, and let beauty conceal the moral cost.",
      avoid:
        "Avoid earnest speeches, plain realism about work or poverty, and any character who explains their own joke. Never let an epigram be merely rude rather than elegant.",
    },
  },
  {
    id: 'p-g-wodehouse',
    name: 'P.G. Wodehouse',
    genres: ['humor', 'classics'],
    knownFor: ['Right Ho, Jeeves', 'The Code of the Woosters', 'Leave It to Psmith'],
    summary:
      "Wodehouse writes perfectly engineered farce in a sunlit England where the worst thing that can happen is an engagement or an aunt. The comic narrators, amiable idle young men in many of the books, mix racetrack slang, misremembered poetry and school jokes in one breath. Plots are intricate clockwork of stolen objects and false identities, and the similes are elaborate jokes in their own right.",
    traits: {
      narration:
        "Use a cheerful, dim, well-meaning first-person young gentleman, who tells the reader what happened in the slang of his club and misses most of what is going on.",
      sentences:
        "Build long, buoyant, beautifully timed sentences that drop into a slangy deflation. Stack a comic simile on a comic subordinate clause, and let the rhythm do the joke.",
      diction:
        "Mix Edwardian schoolboy and club slang with half-remembered lines of poetry and scripture, cut short or muddled. Use exaggerated mock-heroic words for tiny domestic dramas.",
      dialogue:
        "Write rapid cross-purpose exchanges between a chatterer and an imperturbable, far cleverer servant. Give aunts, peers and bullies booming lines and exquisitely polite threats.",
      description:
        "Reduce description to a comic comparison: a person's look or mood compared at length to something absurd and exact. Keep the country houses sunny and the scenery brief and agreeable.",
      pacing:
        "Build farce like a clock, with schemes, an imposter and a stolen object colliding at a country-house weekend. Let a clever servant's plan untangle everything at the end.",
      signature:
        "Land a wildly exact comic simile that nobody else could have reached. Treat the crisis of an unwanted engagement with the mock gravity of an epic, and end with order and lunch restored.",
      avoid:
        "Avoid real pain, sex, death, politics or social realism, and never be bitter. No joke may strain; the voice must sound effortless.",
    },
  },
  {
    id: 'jorge-luis-borges',
    name: 'Jorge Luis Borges',
    genres: ['literary', 'classics', 'fantasy'],
    knownFor: ['Ficciones', 'The Aleph', 'Labyrinths'],
    summary:
      "Borges writes very short fictions disguised as scholarly essays, reviews and encyclopedia notes on books and places that do not exist. A single metaphysical paradox about infinity, identity, time or mirrors is explored with cool erudition. As read in English translation, the prose is exact, dry and classically spare, and footnotes, false citations and a narrator named after the author himself blur the line between fact and invention.",
    traits: {
      narration:
        "Use a learned, modest first-person narrator, often a librarian or scholar, reporting an investigation in the tone of a journal note, as if all of this were documented.",
      sentences:
        "Write compact, formal, polished sentences that balance two adjectives or an unexpected qualifier. Use a calm, ironic tone, and let a big idea arrive in a subordinate clause.",
      diction:
        "Use precise, Latinate, slightly archaic words, with real and invented scholarly references interleaved. Favor recurring images of labyrinths, mirrors, tigers, libraries, knives and dreams.",
      dialogue:
        "Use almost no direct dialogue. Summarize what someone said, as a scholar reports a source, and let a rare spoken line feel decisive.",
      description:
        "Replace scenery with an inventory of an imaginary object: an encyclopedia's entries, a library's rules, a map's implications. Report settings and even violence in a few plain phrases.",
      pacing:
        "Keep each piece to a few pages, reporting on something far larger than the page. Develop a single paradox to its logical end, and close with a quiet reversal that implicates the narrator.",
      signature:
        "Present a fictional book or impossible object through mock-scholarly apparatus, then follow its logic until it eats reality. Reveal that the hunter is the prey or that two opposites are one person.",
      avoid:
        "Avoid psychological realism, long plots, romantic subplots, emotional display and modern colloquial language. Do not stretch an idea past the few pages that exhaust it.",
    },
  },
  {
    id: 'raymond-carver',
    name: 'Raymond Carver',
    genres: ['literary'],
    knownFor: ["What We Talk About When We Talk About Love", 'Cathedral', "Will You Please Be Quiet, Please?"],
    summary:
      "Carver writes short stories about working-class American lives in trouble, in prose stripped to almost nothing. Unemployment, drinking and failing marriages are shown through small events in kitchens and living rooms, and the crisis usually stays beneath the talk. The endings stop short, leaving the reader with a charged moment instead of a resolution.",
    traits: {
      narration:
        "Use a flat first person or a neutral close third on an inarticulate person who cannot name what is wrong. Report without commentary, and let the narrator miss the point.",
      sentences:
        "Write very short, simple declaratives, joined by and. Repeat plain phrases, and cut every adverb and flourish, until only the bare action is left on the page.",
      diction:
        "Use the common words of blue-collar American life: car, drink, kitchen, job, cigarette. Avoid metaphor nearly altogether, and let the same small words recur.",
      dialogue:
        "Write banal, repetitive, halting talk with lots of said, in which couples and strangers avoid the real subject. Let a mild remark carry menace because of what no one will mention.",
      description:
        "Mention just a few household objects, such as an ashtray or a drink on a table, without interpreting them. Let the ordinary object feel slightly threatening.",
      pacing:
        "Keep stories brief, with little happening and something clearly wrong beneath it. End abruptly, before the expected climax or explanation, on a small gesture.",
      signature:
        "Leave out the event that the story is really about, and let the reader feel its pressure in small talk. End on an open moment that refuses to say whether it means hope or doom.",
      avoid:
        "Avoid lyrical language, stated epiphanies, clever narrators, backstory explanations and speeches about feelings. Do not resolve anything or tell the reader what to think.",
    },
  },
  {
    id: 'joseph-heller',
    name: 'Joseph Heller',
    genres: ['literary', 'humor', 'classics'],
    knownFor: ['Catch-22', 'Something Happened', 'Good as Gold'],
    summary:
      "Heller writes war as black comedy, in which military bureaucracy runs on circular logic that leaves victims with no way out. Time loops: a single horrifying event is approached again and again, in greater detail, while the jokes get more desperate. Absurd dialogue spirals into its own contradiction, and the comedy slowly reveals the atrocity that it has been circling.",
    traits: {
      narration:
        "Use a sardonic omniscient third person that jumps among a huge cast of comic obsessives, with no regard for chronology, and reports absurdity with a straight face.",
      sentences:
        "Write sentences that contradict themselves with deadpan logic, using parallel constructions in which the second half cancels the first. Let long lists of paradoxes accumulate.",
      diction:
        "Use official military and business language, memos and euphemisms, in absurd situations. Name each character with a comic tag, and repeat the tag as if it were an explanation.",
      dialogue:
        "Write rapid, circular exchanges in which each answer repeats the question or makes it impossible to answer. Let a superior use irrefutable nonsense to explain why nothing can be done.",
      description:
        "Keep description brief and caricatured until the moment when a wound or death is rendered with sudden, unbearably exact realism. Hide physical horror behind the jokes until then.",
      pacing:
        "Break chronology and cycle back to one traumatic incident, each time revealing more. Let the comedy drain away over the book, until the last sections are nearly all nightmare.",
      signature:
        "Invent a rule that makes itself impossible to escape, and let it apply to everything. Keep returning to the single worst moment until it is finally told in full.",
      avoid:
        "Avoid linear plot, reverent war stories, heroic speeches and a reasonable authority figure. Do not let the bureaucracy make sense, or the jokes make the deaths light.",
    },
  },
  {
    id: 'sally-rooney',
    name: 'Sally Rooney',
    genres: ['literary', 'romance'],
    knownFor: ['Normal People', 'Conversations with Friends', 'Beautiful World, Where Are You'],
    summary:
      "Rooney writes cool, clean, closely observed novels about young Irish adults whose intimacy is complicated by class, money and power. Dialogue runs without quotation marks, and sharp analysis of tiny social signals replaces lyrical description. Her narrators are hyperaware and detached, and the flatness of the style makes a moment of feeling arrive with surprising force.",
    traits: {
      narration:
        "Use a controlled, slightly distant close third or a detached first person who reports her own emotions like facts observed in someone else. Let the narrative note what people think the other person thinks.",
      sentences:
        "Write plain, even sentences of medium length, often in chains joined by and, without showy imagery. Let the understatement keep level, then let a single sentence quietly break.",
      diction:
        "Use a clean, contemporary, educated vocabulary, with references to Marxism, email and university life treated as ordinary. Avoid metaphor, and name emotional states plainly.",
      dialogue:
        "Run dialogue without quotation marks, marked only by he said or she said. Write clever, guarded exchanges and text messages, where the real negotiation is about status and desire.",
      description:
        "Note clothes, phones, money and the small gestures by which class shows itself. Keep landscape and interiors minimal, and describe sex and shame in the same neutral tone.",
      pacing:
        "Advance through conversations and gaps, with small misunderstandings separating two people for months. Skip ahead in time, and let the reader fill in what changed.",
      signature:
        "Have two people repeatedly fail to say the obvious thing because of pride, class or fear. Analyze a brief exchange in minute social detail, then let silence do the damage.",
      avoid:
        "Avoid melodrama, ornate metaphor, plot twists and quotation marks. Do not let the narrator gush or tell the reader that a moment is beautiful.",
    },
  },
  {
    id: 'george-eliot',
    name: 'George Eliot',
    genres: ['classics', 'literary', 'historical'],
    knownFor: ['Middlemarch', 'The Mill on the Floss', 'Silas Marner'],
    summary:
      "Eliot writes long, morally searching novels of English provincial life through a wise, compassionate narrator who stops to think aloud about what she has just shown. A whole town's marriages, money and reputations are woven together, and no one is merely a villain. The narrator reasons from one small act to a general truth about people, then asks the reader for sympathy.",
    traits: {
      narration:
        "Use a deeply intelligent omniscient narrator who enters each mind in turn, generalizes about human nature in the first-person plural, and pleads for sympathy for those least likable.",
      sentences:
        "Write long, carefully reasoned sentences with several qualifying clauses, moving from specific observation to broad reflection, and sometimes finishing with an extended scientific or domestic metaphor.",
      diction:
        "Use a rich, educated Victorian vocabulary drawn from science, theology, medicine and country life. Give provincial speakers their own salty, proverbial idiom.",
      dialogue:
        "Let dialogue expose self-deception: earnest idealists, gossiping neighbors, bores certain of their own learning. Write comic country talk with real affection.",
      description:
        "Describe a town's institutions, property and class gradations in detail, so that the reader understands how pressure reaches each life. Use faces and rooms as moral evidence.",
      pacing:
        "Interweave several plots patiently across years. Let a small past error return with interest, and let the crisis be a quiet moral decision rather than an event.",
      signature:
        "Pause at a crucial moment to reason with the reader about how they would judge this person, widening a village incident into a claim about all human lives. Let ardent hopes meet ordinary constraint.",
      avoid:
        "Avoid villains without inner life, narrators with no opinions, swift plots and cynical endings. Do not let satire overrule compassion.",
    },
  },
  {
    id: 'alexandre-dumas',
    name: 'Alexandre Dumas',
    genres: ['classics', 'historical'],
    knownFor: ['The Three Musketeers', 'The Count of Monte Cristo', 'Twenty Years After'],
    summary:
      "Dumas writes swaggering serial adventures, in which swordfights, disguises and court intrigue race along on floods of witty dialogue. Written for newspaper installments, each chapter ends on a hook. Real history supplies kings and cardinals, while invented heroes with outsized appetites and loyalties do everything that matters. The narrator's enjoyment of it all is infectious.",
    traits: {
      narration:
        "Use a cheerful, confident storyteller who addresses the reader, recounts history at a gallop and openly enjoys his heroes' gallantry and his villains' scheming.",
      sentences:
        "Write swift, flowing nineteenth-century sentences, with little ornament, that keep the story moving. Break long exchanges into short lines of give and take.",
      diction:
        "Use the courtly vocabulary of titles, duels, wine and honor, with period forms of address. Keep it lively and easy, in the English of a good translation.",
      dialogue:
        "Make dialogue the main engine, with long runs of quick repartee, boasts and threats between proud people. Let each hero have an unmistakable manner of talking.",
      description:
        "Give a quick historical sketch, a costume or a room, and return at once to action. Treat food, horses and swords with obvious pleasure.",
      pacing:
        "End almost every chapter on a surprise or suspended danger, as a serial would. Keep plots piling up across years, with an old debt or a disguised enemy returning at the worst moment.",
      signature:
        "Let invented adventurers stand behind the real events of history, secretly causing them. Give a wronged man a long, elaborate, theatrical vengeance, or a band of friends who risk all for a point of honor.",
      avoid:
        "Avoid gloom, introspection, modest heroes and tight, spare prose. Do not let a chapter end at rest.",
    },
  },
  {
    id: 'salman-rushdie',
    name: 'Salman Rushdie',
    genres: ['literary', 'fantasy', 'historical'],
    knownFor: ["Midnight's Children", 'The Moor\'s Last Sigh', 'Haroun and the Sea of Stories'],
    summary:
      "Rushdie writes exuberant, digressive novels in which private lives and national history become entangled through magical conceits. His narrators are garrulous and self-interrupting, in an English bent and enriched by Indian speech, puns and pop culture. Long comic sentences tumble along, stories branch into more stories, and the narrator admits his own errors of fact as he goes.",
    traits: {
      narration:
        "Use a talkative, self-dramatizing first-person narrator who claims personal responsibility for history, and who interrupts himself, anticipates the ending and argues with his listener.",
      sentences:
        "Write long, breathless, comma-spliced sentences that swallow lists, then drop into a short refrain. Compound words together and repeat phrases as leitmotifs.",
      diction:
        "Mix Hindi and Urdu words, Bombay slang, film references, puns and high literary allusion. Let the English be visibly remade by the mouths that use it.",
      dialogue:
        "Write theatrical, overlapping family talk, with outrageous aunts and uncles, verbal tics and catchphrases that return as comedy.",
      description:
        "Overflow with color, smell, food, film posters and crowded streets. Turn an actual bodily feature or family object into a metaphor large enough to hold a nation.",
      pacing:
        "Advance by digression, promising what comes next and delaying it through family stories. Tie each private crisis to a public date, so that birth, war and politics seem to move together.",
      signature:
        "Fuse one person's body or family with a nation's history through a magical conceit. Let an openly unreliable narrator correct his own facts, and treat storytelling itself as a matter of survival.",
      avoid:
        "Avoid restraint, plain minimalist style, linear plot and polite standard English. Do not stick to one mood or tell a story straight.",
    },
  },
  {
    id: 'thomas-pynchon',
    name: 'Thomas Pynchon',
    genres: ['literary', 'historical', 'humor'],
    knownFor: ["Gravity's Rainbow", 'V.', 'The Crying of Lot 49'],
    summary:
      "Pynchon writes huge, paranoid comic novels where every plot might be connected to a vast conspiracy, or to nothing. Encyclopedic learning in rocketry, statistics and forgotten history sits beside slapstick, silly songs and absurd names. Perspective lurches from high lyricism to vaudeville within a paragraph, and the reader, like the heroes, is left trying to decide whether the pattern is real.",
    traits: {
      narration:
        "Use an agile, unpredictable voice that shifts without warning among dozens of oddly named characters and registers, and sometimes breaks in with the we of a movie audience.",
      sentences:
        "Write long, clause-chained sentences that turn from technical to bawdy to lyrical, punctuated with dots and dashes. Let them end somewhere other than where they began.",
      diction:
        "Combine exact terms from physics, chemistry and engineering with stoner slang, period idiom and puns. Give characters ridiculous, punning names, and treat them seriously.",
      dialogue:
        "Write comic, hipster cross-talk full of paranoia and non sequiturs, with people breaking into song. Let lines about entropy or control pass as idle chatter.",
      description:
        "Pile up the obscure details of real history: corporate cartels, stamps, rockets, an old street. Describe things with an expert's pleasure, then tilt them toward the hallucinatory.",
      pacing:
        "Spawn subplots and digressions freely, and refuse to tie them together. Let a quest for a hidden pattern dissolve rather than resolve, stopping on an open, suspended moment.",
      signature:
        "Suggest an all-embracing conspiracy behind history, leaving the heroes and the reader unsure whether it exists. Set low comedy and songs right beside the machinery of mass death.",
      avoid:
        "Avoid a single stable tone, tidy plots, psychological realism and clear explanations. Do not confirm whether the pattern is real.",
    },
  },
  {
    id: 'chuck-palahniuk',
    name: 'Chuck Palahniuk',
    genres: ['literary', 'thriller', 'humor'],
    knownFor: ['Fight Club', 'Choke', 'Survivor'],
    summary:
      "Palahniuk writes transgressive satire in a flat, deadpan first person, built like a chant from short repeated phrases he calls choruses. Narrators are damaged men and women obsessed with trivia and bodies, reporting appalling events in a clinical tone. A how-to detail or a bit of medical fact recurs until it becomes rhythm, and the plot usually turns on a shocking revelation of identity.",
    traits: {
      narration:
        "Use a numb, sardonic first person, often in the present tense, who addresses you and treats horrors as a matter of routine.",
      sentences:
        "Write short, flat declaratives, fragments and imperatives. Repeat a phrase as a chorus every page or so, so that the story moves like a chant.",
      diction:
        "Use blunt, physical, plain words and exact facts from medicine, consumer products and manual trades. Avoid any abstract word for a feeling.",
      dialogue:
        "Keep talk brief, deadpan and oddly formal, with characters repeating slogans and rules. Let dialogue tags recur in a mechanical way as part of the rhythm.",
      description:
        "Give gross-out bodily details and instructions for how a thing is done or made, with a manual's calm. Leave out scenery, and let lists of facts stand in for setting.",
      pacing:
        "Open near the end and circle backward. Move in short, jump-cut sections around a recurring refrain, and spring a late reversal about who the narrator really is.",
      signature:
        "Establish a catchphrase-like chorus and bring it back with changed meaning, and set a how-to digression against an emotional void. Let a support group, a cult or a scheme offer false salvation.",
      avoid:
        "Avoid lyrical description, stated emotions, long flowing sentences and gentle endings. Do not soften the disgust or explain the satire.",
    },
  },
  {
    id: 'annie-proulx',
    name: 'Annie Proulx',
    genres: ['literary', 'western'],
    knownFor: ['The Shipping News', 'Brokeback Mountain', 'Accordion Crimes'],
    summary:
      "Proulx writes tough, compressed fiction about working people at the mercy of hard land, with a thick vocabulary of tools, weather and regional speech. Sentences are jammed with active verbs, sometimes without a subject, and they move like telegrams. Whole lives are summarized in a paragraph, disasters arrive sidelong, and a black comic streak runs through the grim details.",
    traits: {
      narration:
        "Use a distant, knowing, slightly sardonic third person that can cover years in a breath, with occasional intimacy with a stunted, inarticulate person.",
      sentences:
        "Drop subjects and articles to make compressed, verb-driven fragments, then allow a sudden long run. Pile up odd, active verbs, and let rhythm come from a hard, clipped syntax.",
      diction:
        "Use the exact names of knots, tools, ranch gear, plants and local dishes, and rare regional words. Prefer the odd, hard-edged term over a common one.",
      dialogue:
        "Render regional dialect closely, in laconic, mispunctuated speech with old jokes and sudden cruelty. Let people say very little about what is killing them.",
      description:
        "Make land and weather active and violent, with exact geology and wind. Describe bodies and machinery with bleak comic relish.",
      pacing:
        "Compress long periods, then stop for one vivid incident. Let abrupt accidents and deaths arrive offhandedly, often in a subordinate clause.",
      signature:
        "Fuse a place's work, weather and history into fate. Open chapters with an item such as a knot description or a local fact, and report catastrophe in the same breath as a recipe.",
      avoid:
        "Avoid soft, generalized language, tidy sentimental uplift and suburban comfort. Do not use a plain word when the trade has a stranger one.",
    },
  },
];
