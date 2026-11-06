import type { TechniqueData } from './types';

export const TECHNIQUE_DATA: TechniqueData[] = [
  {
    id: 'deep-third-person',
    name: 'Deep third person',
    genres: ['pov', 'voice'],
    summary:
      "Deep third person erases the distance between reader and viewpoint character, so the narration sounds like that character's own thinking even in the third person. There is no narrator above the scene: no filter words, no information they lack, no phrasing they would not use. It gives first-person intimacy while keeping the flexibility of third.",
    traits: {
      narration:
        "Hold one viewpoint per scene and report only what that person perceives, knows or assumes. Never cut to what they cannot see, or to how they look from outside.",
      sentences:
        "Let syntax follow the character's state: clipped when frightened, looping when they are rationalizing. Leave thoughts unitalicized, merged into the narration with no thought tags.",
      diction:
        "Choose only words this person would use, shaped by their age, job and upbringing. A mechanic's metaphors come from engines, and a child's vocabulary stays a child's.",
      dialogue:
        "Filter each line through how the viewpoint character takes it, adding their immediate interpretation, which may be wrong. Give others' motives only as guesses.",
      description:
        "Describe only what this character would notice in this mood, colored by judgment. A familiar room gets almost nothing, and a threat gets everything.",
      pacing:
        "Slow down inside reactions at emotional peaks, and compress anything the character does not care about. Change viewpoint only at a scene or chapter break, with a clear signal.",
      signature:
        "Cut the filter verbs, such as saw, felt, noticed and realized, and state the perception directly. Let the narrative's opinions turn out to be the character's biases.",
      avoid:
        "Avoid head-hopping, authorial foreshadowing, describing the viewpoint character from outside, and any phrase that knows more than the character does.",
    },
  },
  {
    id: 'first-person-retrospective',
    name: 'First-person retrospective',
    genres: ['pov', 'voice'],
    summary:
      "A first-person retrospective is told by an older self looking back, so two versions of one person share the page: the one who lived it and the one who now knows better. The gap between them supplies irony, foreshadowing and regret. It suits coming-of-age stories, memoirs of disaster and any tale where the telling is itself a reckoning.",
    traits: {
      narration:
        "Narrate in past tense as an older person recalling events from a definite later vantage, and let that present moment surface occasionally, giving reasons for telling it now.",
      sentences:
        "Move between an event's immediacy and measured reflection, often in one paragraph, with longer, considered lines for the older voice and simpler ones for the younger self.",
      diction:
        "Write in the older self's vocabulary and era, marking what the younger self would have said instead. Allow admissions that the narrator did not understand something at the time.",
      dialogue:
        "Report talk as remembered, flagging gaps where memory is doubtful, and let the narrator comment on what a remark really meant, which nobody in the room knew then.",
      description:
        "Fix on the details memory would keep: a smell, a coat, one sentence from a day long gone. Mark where the place has since changed or disappeared.",
      pacing:
        "Leap over years with a line, and slow for the few days that mattered. Tell the reader when something will be the last time, then return to the moment.",
      signature:
        "Exploit the double vision: what I thought then against what I know now. Hold back a final admission of guilt that changes the reason for telling the story.",
      avoid:
        "Avoid present-tense immediacy, surprises the older narrator would plainly disclose, and an older self who has learned nothing. Do not let hindsight explain every scene as it happens.",
    },
  },
  {
    id: 'omniscient-narrator',
    name: 'Omniscient narrator',
    genres: ['pov', 'voice', 'classics'],
    summary:
      "An omniscient narrator knows everything and is a presence in its own right, telling the reader what anyone thinks, what will happen next and what it all means. Done well it is not head-hopping, because a single personality controls every move between minds. This is the voice of many classic novels and of a good storyteller holding a room.",
    traits: {
      narration:
        "Speak as a single, identifiable storyteller above the story, free to enter any mind, compare characters and judge them. Move between heads deliberately, using a glance or gesture as the bridge.",
      sentences:
        "Use confident, flexible sentences that can widen to a generalization and then narrow to one person's hand on a door. Let long periodic sentences carry the narrator's thought.",
      diction:
        "Give the narrator a consistent personality in word choice: amused, grave or gossiping. The vocabulary belongs to the narrator, not to any character.",
      dialogue:
        "Set conversations among several people and tell the reader what each hides behind their words, including what they misunderstand about one another.",
      description:
        "Survey from above: open on a town, a family or a century, and then descend. Show the reader what no single person present could see.",
      pacing:
        "Use the freedom to summarize years, jump to simultaneous events and announce what will come. Build suspense by telling the reader what is about to happen, then show the cost.",
      signature:
        "Comment directly to the reader, with maxims about human nature, and tell the future of a minor character in passing. Let the narrator's sympathy be the book's moral center.",
      avoid:
        "Avoid shapeless hopping between minds with no controlling personality. Do not restrict the telling to what one character knows, and do not let the narrator vanish for chapters.",
    },
  },
  {
    id: 'unreliable-narrator',
    name: 'Unreliable narrator',
    genres: ['pov', 'voice', 'literary'],
    summary:
      "An unreliable narrator tells the story in ways the reader gradually learns not to trust, through self-deception, madness, vanity, youth or outright lying. The pleasure is reading past the teller to what really happened. Clues sit in contradictions, in other characters' reactions and in what the narrator hurries past.",
    traits: {
      narration:
        "Use first person, or a very close third, from someone with a motive to misreport. Let them sound sincere and reasonable, and never have the book step in to correct them.",
      sentences:
        "Put tells in the syntax: qualifiers, over-explaining, sudden changes of subject after a sensitive point, and repeated insistence that something did not matter.",
      diction:
        "Let word choice betray the speaker: euphemisms for what they did, flattering terms for themselves, and a chilling or sentimental word where a normal one belongs.",
      dialogue:
        "Report what others said in a way that lets the reader hear what the narrator misses. Let another person's puzzled, frightened or pitying reply reveal how the narrator really appears.",
      description:
        "Let the narrator linger on trivial details when a painful one is near. Include an object or fact that can't be squared with their version.",
      pacing:
        "Establish trust early, then plant small contradictions in dates, names and motives. Let doubt accumulate until an outside document or witness shows a different story, or until nothing is certain.",
      signature:
        "Let the reader see more than the teller admits, so the real story runs beneath the told one. Play fair: every reveal must be traceable to something already on the page.",
      avoid:
        "Avoid a twist with no earlier clues, a narrator who announces the lying, and a final chapter that explains everything. The narrator must not outgrow their blind spot.",
    },
  },
  {
    id: 'hardboiled',
    name: 'Hardboiled',
    genres: ['voice', 'crime', 'mystery'],
    summary:
      "Hardboiled writing is the tough, street-level voice of American crime fiction: a cynical, self-reliant person moving through a corrupt city and reporting it in hard, dry language. Sentiment is concealed, violence is frequent, and the wit is defensive. The moral center is a private code that nobody else respects, and it rarely pays.",
    traits: {
      narration:
        "Use first-person past or a flat close third from a worldly operator who has seen it before, works for pay and confides nothing about how much anything hurts.",
      sentences:
        "Keep sentences short and blunt, with a strong noun and verb, and let a dry joke close the paragraph. Repeat a simple structure for a drumbeat.",
      diction:
        "Use streetwise, concrete American words and period-appropriate slang, with money and liquor named plainly. Prefer a wisecrack or an unexpected comparison to any expression of feeling.",
      dialogue:
        "Make talk a contest: threats as jokes, lies as courtesy. Nobody answers a question directly, and a hard line beats a long speech.",
      description:
        "Size up a person or room in a line or two by what it costs and who it is hiding from. Favor rain, neon, cheap rooms and rich people's bad taste.",
      pacing:
        "Move from interview to double-cross, with a beating or a body whenever talk stalls. Let the case spread upward to the respectable people, and end with a small, compromised justice.",
      signature:
        "Run a private code beneath a cynical surface, so that the hero does the decent thing and denies it. Let the city be as guilty as the killer.",
      avoid:
        "Avoid explaining feelings, earnest speeches, tidy victories and cozy settings. Do not overload every line with similes until the voice turns into parody.",
    },
  },
  {
    id: 'minimalist',
    name: 'Minimalist',
    genres: ['voice', 'literary'],
    summary:
      "Minimalism strips prose to surface facts: what people do and say, in plain words, with the feeling left underneath. Working-class kitchens, failing marriages and unfinished conversations are typical ground, though the method travels anywhere. The reader does the emotional work, and what is missing from the page is the real subject.",
    traits: {
      narration:
        "Use an uninflected narrator who stays outside people's heads or reports only small, literal thoughts. Never name the emotion at stake, or say what a moment means.",
      sentences:
        "Write short, simple declaratives with common verbs, chiefly joined by and. Cut adjectives and adverbs, and accept repetition rather than reach for a fancier word.",
      diction:
        "Stick to everyday words, brand names and nouns you can touch. Avoid metaphor nearly entirely, and prefer said for every line of speech.",
      dialogue:
        "Let people talk past the real subject, about the car or a drink, in banal lines with long pauses. End the exchange before anyone says the important thing.",
      description:
        "Give a few plain objects on a table, and what someone does with their hands. Let a single object carry the unspoken weight without comment.",
      pacing:
        "Begin in the middle of an ordinary moment and end without resolution, just after a small shift. Leave the decisive event before or after the scene you show.",
      signature:
        "Practice omission: keep the central fact off the page, so that the reader feels it pressing under small talk. End on a flat image rather than a realization.",
      avoid:
        "Avoid lyricism, backstory, summarizing epiphanies, clever narration and big plot events on the page. Cut any sentence that explains.",
    },
  },
  {
    id: 'lyrical',
    name: 'Lyrical',
    genres: ['voice', 'literary'],
    summary:
      "Lyrical prose borrows the tools of poetry, rhythm, sound and image, so that the language itself carries emotion alongside or ahead of the plot. Its sentences are meant to be heard, and metaphors often build into larger patterns over a book. At its best the beauty serves the feeling, and it works especially well for memory, grief, nature and longing.",
    traits: {
      narration:
        "Use an intimate, meditative voice, in first person or a porous third, where perception and feeling merge. Let the narrator linger over what an experience was like, more than what happened.",
      sentences:
        "Vary length with a musician's ear, using long cumulative lines, repeated openings, and a short line for release. Attend to vowel sounds and end stresses, and shape each line for rhythm.",
      diction:
        "Favor concrete, sensual, often simple words in fresh pairings. Let recurring images of water, light or birds work like motifs across chapters rather than as decoration.",
      dialogue:
        "Use talk sparingly, and let it sound spare next to the narration. Sometimes render speech indirectly, folded into the narrator's rhythm, without quotation marks.",
      description:
        "Let the natural world and the body carry emotional states. Build one precise image to carry a whole scene's meaning, instead of listing many.",
      pacing:
        "Move by association and echo as much as by event, letting a memory interrupt the present. Give a quiet moment as much room as a crisis, and end on an image rather than an outcome.",
      signature:
        "Develop a single metaphor over pages until it changes meaning, and return to a phrase in a later chapter so that it lands with new weight.",
      avoid:
        "Avoid stock poetic words such as gossamer and ethereal, stacked adjectives, and imagery that obscures what happened. Beauty must not replace feeling or clarity of action.",
    },
  },
  {
    id: 'cozy',
    name: 'Cozy',
    genres: ['voice', 'mystery', 'fantasy'],
    summary:
      "Cozy fiction promises comfort: a small community, a beloved routine, low-level peril and the certainty that things will come right. Whether a village mystery or a gentle fantasy, it takes pleasure in food, friendship, craft and pets. Violence, if any, happens offstage, and the reader is invited to settle in among likable people.",
    traits: {
      narration:
        "Use a warm, gently amused voice near a kindly amateur with a small business or hobby, and let them be fond of their neighbors, even the difficult ones.",
      sentences:
        "Write relaxed, friendly, medium-length sentences with an easy rhythm and small humorous observations, as if told over tea.",
      diction:
        "Use homely, comforting words for baking, gardening, knitting and shopkeeping. Keep out profanity, graphic terms and jargon, and let mild euphemism be part of the charm.",
      dialogue:
        "Write neighborly gossip and friendly teasing, with eccentric locals who talk a lot and reveal things by accident. Let disputes be about parking, pies or old slights.",
      description:
        "Dwell on snug spaces: a warm kitchen, a cat on the windowsill, the smell of bread, seasonal festivals. Make the reader want to live there.",
      pacing:
        "Move gently through daily rounds, with the problem solved through conversation and local knowledge. Give each chapter a small pleasure, and finish with everyone gathered around a table.",
      signature:
        "Make the community itself the reward: a found family, shared food, small rituals and a recipe or craft detail. Restore order at the end, with no one lastingly harmed who matters.",
      avoid:
        "Avoid on-page gore, sexual violence, bleak endings, cruelty to animals and cynical narrators. Don't let the stakes threaten the safety of the whole setting.",
    },
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    genres: ['voice', 'structure', 'thriller'],
    summary:
      "Cinematic prose writes what a camera could record: external action, striking images, quick cuts and scenes entered late. Interior thought is kept short, and meaning is shown through behavior and staging. It suits thrillers and action, and makes a reader see a sequence as clearly as if it were on screen.",
    traits: {
      narration:
        "Stay external, as a camera would, using third person and showing behavior rather than thought. Choose the shot: wide on a place, then close on a hand or a face.",
      sentences:
        "Favor active verbs and movement, with short lines during action. Let paragraph breaks act like edits, each new paragraph a new shot.",
      diction:
        "Use visual, physical words that can be filmed. Prefer what something looks and sounds like to abstractions, and cut anything that could only be known through narration.",
      dialogue:
        "Keep lines short and heavy with subtext, with characters doing something physical while they talk. Let a look or action replace the reply.",
      description:
        "Block each scene: who stands where, where the light falls, what moves. Establish geography in one quick shot, and use sound and a telling detail for mood.",
      pacing:
        "Enter scenes late and leave early, cutting on action between parallel threads. Use cross-cutting to build a countdown, and end scenes on a strong visual.",
      signature:
        "Open with a big set piece or striking image, and use match cuts between scenes, ending one on an object and opening the next on its echo.",
      avoid:
        "Avoid long interior monologue, summary and backstory blocks, and abstract reflection. Don't use explicit film terms such as cut to or close-up in the prose.",
    },
  },
  {
    id: 'epistolary',
    name: 'Epistolary',
    genres: ['structure'],
    summary:
      "Epistolary fiction is told through documents: letters, diaries, emails, transcripts, reports. Each piece has a writer, a reader and a reason, so what gets left out or slanted is part of the story. Gaps between documents create suspense, and the reader plays detective, assembling events no one narrator sees whole.",
    traits: {
      narration:
        "Tell the whole story through items one person wrote for another, or for themselves. Give each writer a purpose, an audience and something they would rather not say.",
      sentences:
        "Match form to medium: long, composed sentences for letters, fragments for diaries, terse headers and abbreviations for logs, and messy run-ons for hurried messages.",
      diction:
        "Distinguish every writer by spelling, formality, pet phrases and what they call each other. A clerk's report and a lover's note must not sound alike.",
      dialogue:
        "Render conversation only as a writer could recollect it, condensed and slanted, or as transcripts with speaker labels. Let one writer quote another to disagree.",
      description:
        "Include only what the writer would bother to mention to this reader, and use dates, letterheads, signatures and postscripts as information.",
      pacing:
        "Use the time between documents to skip events, then reveal them through their aftermath. End an item mid-crisis, and let the next be from someone unaware of it.",
      signature:
        "Let documents contradict each other so that the reader works out the truth, and make a missing letter or a sudden change in handwriting the biggest shock.",
      avoid:
        "Avoid letters that read like ordinary novel scenes, with full dialogue and description nobody would write down. Do not let all correspondents share one voice.",
    },
  },
  {
    id: 'stream-of-consciousness',
    name: 'Stream of consciousness',
    genres: ['pov', 'literary'],
    summary:
      "Stream of consciousness tries to put the flow of a mind on the page: perceptions, memories, half-thoughts and associations arriving in the order they occur to a person rather than the order a story would want. Little happens outwardly, and a single day can hold a lifetime. The reader learns a person from inside, by their mental habits.",
    traits: {
      narration:
        "Stay wholly inside one consciousness, or pass it between people at a shared sight or sound. Give no explanatory narrator, and let the present moment trigger memories without warning.",
      sentences:
        "Let sentences run on, loop and interrupt themselves, with loose punctuation and sudden fragments. Follow the mind's associations instead of grammatical order.",
      diction:
        "Use the character's private vocabulary, unexplained names and pet phrases, mixing the mundane with the deep. Let a single word return like an obsession.",
      dialogue:
        "Let spoken lines arrive embedded in thought, perhaps without quotation marks, half-heard and quickly drifting into the person's own response or a memory.",
      description:
        "Render sense impressions as they occur: a smell, a bus passing, a stain, each of which sets off something else. Do not set a scene as a neutral observer would.",
      pacing:
        "Make the outward plot tiny, often a single day or an errand. Let time move by association, and make a buried memory or fear keep coming back closer to the surface.",
      signature:
        "Move through associative links so that a chance sight opens an old wound, and build meaning through recurrent motifs. Let the reader piece together the facts of a life from scattered references.",
      avoid:
        "Avoid tidy summaries, explaining who someone is, tagging thoughts with he thought, and arranging memories chronologically.",
    },
  },
  {
    id: 'present-tense-urgency',
    name: 'Present-tense urgency',
    genres: ['voice', 'thriller', 'young-adult'],
    summary:
      "Writing in present tense denies the comfort of a narrator who survived to tell the tale; everything is happening now, with no hindsight. Combined with tight viewpoint and short paragraphs, it creates constant forward pressure and a sense that anything could happen next. It is common in thrillers and young adult fiction.",
    traits: {
      narration:
        "Write in present tense, in first person or close third, knowing nothing beyond this instant. Never use foreshadowing or a later perspective, since no one yet knows how it ends.",
      sentences:
        "Favor short, active sentences and fragments that follow the eye and the body. Break lines for shocks and let breath run out with the character's.",
      diction:
        "Use concrete physical verbs and plain words. Drop reflective connectives such as later or by then, and keep past tense only for brief, necessary memories.",
      dialogue:
        "Keep exchanges quick and interrupted, with lines overlapping the action. Let decisions get made mid-sentence, with no pause to weigh them.",
      description:
        "Capture only what registers on the run: a flash of a sign, the taste of blood, footsteps behind. Mention a detail only when it becomes an obstacle or an opening.",
      pacing:
        "Start in motion, and minimize transitions and time gaps. End scenes mid-action and resume immediately, and slow down only for short moments of held breath.",
      signature:
        "Keep the outcome truly open by failing the viewpoint character's plan in real time, and let crucial moments stretch, narrating seconds in close detail.",
      avoid:
        "Avoid leisurely backstory, summary, philosophizing and slips into past tense. Don't let a narrator predict what will happen next or reflect as if it is over.",
    },
  },
  {
    id: 'grimdark',
    name: 'Grimdark',
    genres: ['voice', 'epic-fantasy', 'fantasy'],
    summary:
      "Grimdark fantasy takes away the comforts of heroic tales: power corrupts, quests fail, institutions are rotten, and the person holding the sword is seldom better than the one under it. Bleakness is usually leavened with black humor. The reader is asked to care about people in a world that won't reward them for being good.",
    traits: {
      narration:
        "Use tight viewpoints from morally compromised people, such as mercenaries and torturers, who justify themselves. Let the story withhold clear judgment, and make sympathy uncomfortable.",
      sentences:
        "Write hard, physical sentences, blunt and unlovely, with sardonic endings. Avoid any rising heroic cadence unless you mean to break it on the next line.",
      diction:
        "Use coarse, earthy, bodily language and contemporary profanity. Strip the romance from titles, and treat words like honor with suspicion.",
      dialogue:
        "Write bitter, exhausted banter among survivors. Let a noble speech be immediately undercut, and make threats casual, because violence is routine.",
      description:
        "Show rot: disease, dirty wounds, hunger, looting and how armies treat villages. Describe the aftermath of battles as carefully as the fights.",
      pacing:
        "Give hope, then withdraw it. Let plans fail for stupid reasons, let important people die ignobly, and make victory bring new horrors rather than an end.",
      signature:
        "Invert a heroic expectation: the savior is a monster, the prophecy a fraud, the honest man dead by noon. Let one small mercy matter because it buys nothing.",
      avoid:
        "Avoid pure good versus evil, clean heroes, shock for its own sake and relentless misery with no humor or humanity. Sexual violence should never be used as scenery.",
    },
  },
  {
    id: 'comedy-of-manners',
    name: 'Comedy of manners',
    genres: ['voice', 'humor', 'classics', 'romance'],
    summary:
      "A comedy of manners finds its drama in drawing rooms: rules of class, courtship and politeness, and those who bend or misunderstand them. Wit is the main weapon, and hypocrisy the main target. Plots turn on a snub, an invitation or a letter, and no one is ever quite allowed to say what they mean.",
    traits: {
      narration:
        "Use a poised, ironic narrator, amused by social pretension, who reports what people think they are doing and lets the reader see what they are actually doing.",
      sentences:
        "Write balanced, polished sentences with a sting in the tail, in which a compliment turns into an insult at the last word.",
      diction:
        "Use the refined vocabulary of polite society, where a mild word does heavy damage. Treat etiquette terms with mock solemnity, and let euphemism hide every hostility.",
      dialogue:
        "Make wit the battleground: epigrams, veiled insults and elaborately courteous attacks. Give each fool a comic verbal habit, and let what is left unsaid decide the scene.",
      description:
        "Note dress, seating, the cost of a carriage and who calls on whom. Use these social markers to show rank precisely, and treat landscape only as an occasion for a visit.",
      pacing:
        "Move from one social occasion to another: dinners, balls, visits. Let misunderstandings and vanity complicate things, and end in reconciliation and well-matched marriages.",
      signature:
        "Expose hypocrisy through an outsider or a too-honest person who breaks the rules, and let the biggest events of the plot be a public snub or an improper remark.",
      avoid:
        "Avoid physical action, melodrama, open declarations of rage and broad slapstick. Nobody should say a feeling plainly if a polite remark could convey it.",
    },
  },
  {
    id: 'fairy-tale-voice',
    name: 'Fairy-tale voice',
    genres: ['voice', 'fantasy', 'childrens'],
    summary:
      "The fairy-tale voice speaks with calm authority of things that could never happen, as if they were common knowledge. Characters are types, magic needs no explanation, and the world runs on rules of three, promises and prices. Its plain surface lets cruelty and wonder sit side by side, unexplained, in a story that feels very old.",
    traits: {
      narration:
        "Use a distant, matter-of-fact teller who knows how the tale ends, naming people by role or trait: the youngest daughter, the woodcutter. Report the impossible without surprise.",
      sentences:
        "Write simple, rhythmic sentences linked by and, then or so, with set phrases that return as refrains. Let them sound as if spoken aloud many times.",
      diction:
        "Use plain, old-fashioned, concrete words: bread, iron, thorn, apple. Avoid psychology words and modern idiom, and state time and place in vague formulas.",
      dialogue:
        "Keep speech brief, formal and ritual, with bargains and riddles stated exactly. A promise, once spoken, binds, so let every word be chosen with care.",
      description:
        "Use few, bright, emblematic details: a red shoe, a glass hill, snow on a black branch. Prefer color and material to texture and mood.",
      pacing:
        "Move quickly, and cross years in a sentence. Build in threes, repeating each attempt with a change, and let the ending arrive by the tale's own logic of reward and punishment.",
      signature:
        "Give magic a price and a rule, and have the breaking of a small prohibition drive everything. Let cruelty be stated in the same mild tone as kindness.",
      avoid:
        "Avoid explanation, realistic psychology, worldbuilding detail, irony at the tale's expense and named places. Never give the reader a reason for the magic.",
    },
  },
  {
    id: 'technical-realism',
    name: 'Technical realism',
    genres: ['voice', 'hard-sf', 'technothriller'],
    summary:
      "Technical realism treats how things actually work as the core of the drama. Procedures, materials, numbers and failure modes are accurate and specific, so that readers believe the stakes and solve along with the characters. It runs on the pleasure of expertise, whether the subject is a reactor, a surgical ward or a sailing rig.",
    traits: {
      narration:
        "Follow people who know their work, and let them think in steps, tolerances and contingencies. Report their procedure as they perform it, without apology.",
      sentences:
        "Prefer clear, exact sentences in logical order, in which cause comes before effect. Let a short plain sentence report the moment a reading goes wrong.",
      diction:
        "Use real terminology, correct units, part names and the trade's shorthand, explained once by context. Never use a vague word such as device where the exact term exists.",
      dialogue:
        "Write concise professional talk: checklists, readbacks, disagreements over data. Let experts interrupt to correct numbers, and let a novice's question explain the concept.",
      description:
        "Describe how the thing is built and what limits it: load, heat, time, supply. Give the real constraints before the crisis, so that the reader understands what failure means.",
      pacing:
        "Set up a system and its margins, then erode them one at a time. Make each fix take realistic time and have a cost, and let small overlooked faults compound.",
      signature:
        "Make the solution come from known physical facts established earlier, and never from an invention introduced at the moment of need. Let a sum on the page be a plot point.",
      avoid:
        "Avoid technobabble, magic fixes, instant expertise and errors a practitioner would catch. Never take a dramatic shortcut with accuracy without paying for it in the plot.",
    },
  },
  {
    id: 'gallows-humor',
    name: 'Gallows humor',
    genres: ['voice', 'humor'],
    summary:
      "Gallows humor jokes in the face of death, disaster or despair, not to make light of it but to survive it. It is the sound of soldiers, medics, prisoners and anyone else who cannot leave the room. The jokes gain force from the danger, and the best of them stop abruptly when something truly hurts.",
    traits: {
      narration:
        "Use a dry, seen-it-all voice, in first person or close third, from someone trapped in a bad situation who narrates calamity as an inconvenience.",
      sentences:
        "Set up a horror with flat calm and finish with an understated punchline. Let the rhythm stay casual, so the joke lands before the reader has time to wince.",
      diction:
        "Mix professional jargon with mock-cheerful euphemism for dying, injury and failure. Apply the language of bills, weather or bad service to lethal events.",
      dialogue:
        "Write grim wisecracks passed between people sharing the danger: betting on who goes first, complaining about the food at a time like this. Let outsiders be shocked.",
      description:
        "Note the absurd detail in the catastrophe: a shoe in the wreckage, a form still to be filled in. Keep it matter-of-fact rather than grotesque.",
      pacing:
        "Alternate jokes with rising danger, and then let one scene drop the humor entirely when the loss is real. Afterward, let the first joke back be the sign of recovery.",
      signature:
        "Make the joke a coping tool that the reader learns to read: the worse things get, the drier the line. Mark true grief by the moment someone can't manage a quip.",
      avoid:
        "Avoid mocking the victims, jokiness that removes the stakes and wacky zaniness. Don't explain that the humor is a defense.",
    },
  },
  {
    id: 'slow-burn-tension',
    name: 'Slow-burn tension',
    genres: ['structure', 'thriller', 'horror', 'romance'],
    summary:
      "Slow-burn writing builds pressure by accumulation rather than by event: small wrong details, delayed outcomes, desires or threats held just out of reach for a long time. Little overtly happens at first, which makes the eventual release hit hard. It works for dread, romance and mystery alike.",
    traits: {
      narration:
        "Stay close to a character who notices little things and explains them away. Let the reader's suspicion run ahead of the viewpoint character's.",
      sentences:
        "Keep a measured, controlled rhythm, and avoid exclamatory language early on. Let the calm prose tighten gradually, with sentences shortening only near the release.",
      diction:
        "Use restrained, ordinary words, with an occasional slightly off one. Hold back strong terms such as terror or desire until the story has earned them.",
      dialogue:
        "Let people skirt the issue. Make a repeated pleasantry, an unfinished sentence or a too-long silence carry charge, and delay the line that everyone is waiting for.",
      description:
        "Place one small wrong detail in each otherwise normal scene, such as a door ajar or a look held too long, and let these details repeat and worsen.",
      pacing:
        "Stretch the interval between setup and payoff, raising stakes by small increments. Provide partial releases that leave more questions, and spend the real release late.",
      signature:
        "Promise early, by an image or a warning, what is coming, then make the reader wait for it. Let the climax be brief because the buildup has done the work.",
      avoid:
        "Avoid jump scares, an early climax, filler with no rising pressure and characters who state the tension aloud. Slow must never mean nothing is changing.",
    },
  },
  {
    id: 'multi-pov-ensemble',
    name: 'Multi-POV ensemble',
    genres: ['pov', 'structure'],
    summary:
      "An ensemble novel spreads the story across many viewpoints, each with a stake, a secret and a partial view of the truth. Interest comes from dramatic irony, since the reader sees what each one misses, and from the way separate lines cross. Clear chapter-by-chapter switches and strong individual voices keep a large cast manageable.",
    traits: {
      narration:
        "Give each viewpoint its own chapters or clearly marked sections in close third or first. Keep their knowledge strictly separate, and let each be the hero of their own story.",
      sentences:
        "Vary rhythm by character, so that one person's chapters are terse and another's are ruminative. A reader should recognize a voice without seeing the name.",
      diction:
        "Assign each viewpoint a distinct vocabulary from their job, class and obsessions, and carry it into the narration as well as their speech.",
      dialogue:
        "Show one conversation from two sides across chapters, with each party misreading the other. Let people lie in a way the reader can check against an earlier chapter.",
      description:
        "Let each viewpoint notice different things in one shared place: the soldier counts exits, the merchant prices the furniture. Reuse locations to show how perception varies.",
      pacing:
        "Cut away at moments of high tension, using a hook to carry the reader through other viewpoints. Bring threads closer together, and stage a set piece where they collide.",
      signature:
        "Use irony between chapters: show a plan, then follow its target in ignorance. Let an early minor figure in one thread become decisive in another.",
      avoid:
        "Avoid a viewpoint with no stake, identical-sounding narrators, too many introductions at once and a recap of what the reader saw in another chapter.",
    },
  },
  {
    id: 'second-person',
    name: 'Second person',
    genres: ['pov', 'literary'],
    summary:
      "Second person addresses the protagonist as you, which makes the reader a participant, an accused, or someone being remembered. It may be a person talking to themselves, a narrator speaking to a beloved, or instructions for a life. The effect is intimate and slightly coercive, so it works best with a clear reason for being used.",
    traits: {
      narration:
        "Address the protagonist as you throughout, usually in present tense. Decide who is speaking and why, and let that reason emerge, whether self-accusation, instruction or address to a lost person.",
      sentences:
        "Write direct, command-flavored sentences with a steady incantatory beat. Use instructions and predictions about what you will do next to give a sense of inevitability.",
      diction:
        "Use plain words and everyday specifics, so that the reader can step into them. Keep the speaker's attitude audible in word choice: tender, mocking or prosecuting.",
      dialogue:
        "Keep others' lines short and aimed at you, with your own replies often only implied or reported, as if the reader is responding without saying anything on the page.",
      description:
        "Describe the room as your own habit knows it: your keys, your street, the stair you skip. Treat the setting as already familiar, not to be explained.",
      pacing:
        "Keep it short or add structural variety, as the address grows intense. Move forward through what you do next, and reveal late who has been speaking.",
      signature:
        "Tell a person what they did, and make the reader feel accused or implicated. Let a shift to I at a key point reveal the hidden speaker.",
      avoid:
        "Avoid using you merely as a gimmick with no speaker or purpose, explaining things you would already know, and stretching the device without any change of pressure.",
    },
  },
  {
    id: 'nested-frame-story',
    name: 'Nested frame story',
    genres: ['structure', 'gothic', 'classics'],
    summary:
      "A frame story holds another story inside it: a stranger's tale at an inn, a manuscript found in a trunk, a confession to a visiting doctor. Each layer has its own teller and audience, and the distance raises questions about what can be believed. Outer and inner stories comment on each other and often meet at the end.",
    traits: {
      narration:
        "Set up an outer narrator who meets or receives the story, then pass the voice to an inner teller. Remind the reader now and then that someone is speaking to someone.",
      sentences:
        "Give each layer its own style: a composed outer voice and a looser spoken manner for the teller. Let a pause for a drink break the inner telling.",
      diction:
        "Mark layers by vocabulary: the listener's educated reserve, and the teller's dialect or trade. A found manuscript can use an older idiom, with an editor's notes in a modern one.",
      dialogue:
        "Include the outer listener's questions and doubts between sections. Let a teller quote people from memory, and be challenged on it by their audience.",
      description:
        "Anchor the frame in a specific setting such as a snowed-in room or a ship's deck, and return to it at intervals. Let the frame's weather echo the inner tale.",
      pacing:
        "Return to the frame to delay a revelation at a critical moment. Let a tale enclose another, and let the last pages return to the frame changed.",
      signature:
        "Make the outer story matter by ending with the listener affected or endangered by what they have heard. Let the reader judge what the teller has left out.",
      avoid:
        "Avoid a frame that is only decoration and is dropped and forgotten. An inner teller should not narrate with knowledge they could not have.",
    },
  },
  {
    id: 'mock-scholarly-with-footnotes',
    name: 'Mock-scholarly with footnotes',
    genres: ['voice', 'structure', 'humor'],
    summary:
      "The mock-scholarly manner presents fiction as research: invented histories, annotations, citations of books that do not exist, an editor's corrections. Footnotes become a second voice that jokes, digresses, disputes the text or slowly tells another story. The deadpan academic tone makes the impossible feel documented and provides much of the comedy.",
    traits: {
      narration:
        "Narrate as a learned editor or historian, sober and slightly pedantic, who treats fantastic matters as settled scholarship. Let their vanity, rivalries or fears leak into the apparatus.",
      sentences:
        "Write measured, qualified academic sentences, with hedges about what has been argued. Let a long footnote run on beyond its usefulness, then land a dry joke.",
      diction:
        "Use scholarly terms such as ibid and apocryphal, along with invented authorities and book titles in the setting's own world. Keep a straight face at all times.",
      dialogue:
        "Present speech as reported testimony, quoted from sources, with dates and disputed wordings. Let scholars squabble in the notes over who said what.",
      description:
        "Document everything: give invented editions, archives, weights and measures, and competing accounts of one place. Treat an absurd detail with the same exactness as a serious one.",
      pacing:
        "Keep the main story moving while the notes branch away, and put key plot information in an easily skipped footnote. Let the apparatus grow more personal as the story goes on.",
      signature:
        "Let the footnotes tell a second story that contradicts or haunts the main one. Cite imaginary sources with complete confidence, and let a correction become a turning point.",
      avoid:
        "Avoid winks that break the scholarly pose, footnotes with no payoff and real citations. Do not use real scholars or invent claims about real books.",
    },
  },
  {
    id: 'picaresque',
    name: 'Picaresque',
    genres: ['structure', 'humor', 'classics'],
    summary:
      "A picaresque follows a low-born rogue on the road through episode after episode, surviving on wits and seeing every class of society from below. The structure is loose, with masters, scams and disasters coming one after another. It gives a wide comic survey of a whole world, and satire comes naturally because a poor outsider sees through everybody.",
    traits: {
      narration:
        "Use a cheerful first-person rogue, telling their own adventures with unrepentant candor, from a low position that lets them look up at respectable people.",
      sentences:
        "Write lively, running, talkative sentences that rush through incident, with a shrug at the end of each misfortune, as though told in a tavern.",
      diction:
        "Use earthy, slangy, streetwise words mixed with comically misapplied grand language. Let the rogue name the tricks of each trade with professional pride.",
      dialogue:
        "Write quick con-artist patter and comic exchanges with marks, officials and employers. Give every new type on the road a distinct voice and a bad idea.",
      description:
        "Give a rapid, comic snapshot of each new town, trade, inn or household, from how the poor eat to how the grand cheat. Never stay long.",
      pacing:
        "Move episodically: new master or place, a scheme, a fall and a hasty exit. Keep chapters nearly self-contained, and keep moving rather than building one central plot.",
      signature:
        "Let the rogue's changing employments make up a satirical tour of a society. Have fortune rise and crash repeatedly without teaching the hero anything lasting.",
      avoid:
        "Avoid a tightly plotted arc, solemn self-improvement, long introspection and staying in one place. Do not let the rogue become respectable, at least not for long.",
    },
  },
  {
    id: 'dual-timeline',
    name: 'Dual timeline',
    genres: ['structure', 'historical'],
    summary:
      "A dual timeline novel alternates between two periods, usually a past and a present, whose links gradually come clear. Each strand raises questions the other answers, and the reader enjoys finding echoes: an object, a place or a family secret. The tension lies in the gap, since we know part of how things turn out before we learn how they got there.",
    traits: {
      narration:
        "Alternate chapters between two periods with separate viewpoints, clearly labeled by date. Give the older strand a different tense or voice, so the reader orients at once.",
      sentences:
        "Give each era its own rhythm, perhaps a more formal, longer line for the past and a quicker contemporary one for the present, without turning either into pastiche.",
      diction:
        "Keep period vocabulary and attitudes strictly in their timeline, and have a recurring word or object mean something different in each.",
      dialogue:
        "Let present-day characters discuss the past wrongly, then show what really happened. Let a phrase spoken in one timeline echo in the other.",
      description:
        "Show one house, letter or necklace in both eras, worn by time in the later one. Use a physical object as the bridge between strands.",
      pacing:
        "End each chapter on a question that the other timeline seems to answer, and reveal how the strands connect at about two-thirds through. Let the last reveal reframe the present-day character's choice.",
      signature:
        "Let the modern investigator's discovery coincide with the moment the past strand reaches the same event. Use what the reader has seen in one era as foreshadowing in the other.",
      avoid:
        "Avoid a strand that is merely framing, coincidence with no cause and identical voices. Do not withhold information only by having someone refuse to talk.",
    },
  },
  {
    id: 'satire',
    name: 'Satire',
    genres: ['voice', 'humor', 'literary'],
    summary:
      "Satire exaggerates a real folly until it is plain to see, using a straight face and a precise target. An institution or belief is followed logically to absurd conclusions, often through a naive hero or an enthusiastic defender. The comedy has a point, and the book gets sharper as readers recognize their own world in it.",
    traits: {
      narration:
        "Use a deadpan narrator who appears to accept the absurd system entirely, or an innocent observer who reports it with admiring incomprehension.",
      sentences:
        "Write clean, official-sounding sentences that state monstrous things reasonably. Let the joke lie in the calm, logical steps, finishing on the plainest word.",
      diction:
        "Imitate the target's language: corporate memos, sermons, political spin, advertising. Turn its favorite euphemisms on themselves without adding a wink.",
      dialogue:
        "Write people who defend the indefensible with perfect sincerity, using jargon and slogans, while a bewildered outsider asks the obvious question.",
      description:
        "Exaggerate one real feature of the target until its true shape appears: give a precise, plausible detail of an absurd rule, office or product.",
      pacing:
        "Start with a plausible premise, then escalate step by logical step to a conclusion far worse. Let each chapter reveal a new department of the absurdity.",
      signature:
        "Take a society's stated logic literally, and follow it through to an outrageous but consistent end. Keep the target specific, and aim upward at the powerful.",
      avoid:
        "Avoid pointing out the moral, scattershot zaniness, mean jokes about the weak and a narrator who winks at the reader. A vague target produces no satire.",
    },
  },
];
