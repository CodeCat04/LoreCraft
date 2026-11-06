//! A measurement of search by meaning at book scale, with the real built-in model. Not run by
//! default, since it embeds a whole book:
//!
//! ```text
//! LORECRAFT_MODEL_DIR=<folder with model.safetensors and vocab.txt> \
//!   cargo test --lib embeddings::bench -- --ignored --nocapture --test-threads=1
//! ```
//!
//! The book is the E2E test's: 100,000 words of market towns and mills. Fourteen passages are
//! planted in it, each with a question that should find it. The first twelve share no words
//! with their passage beyond small ones like "the". Recall counts a question as answered at a
//! place if its passage is shown there, as the writer would see it: the scene, with that
//! passage as its snippet.
//!
//! `book_scale_through_the_app` measures what ships, through `embeddings.step`, `search` and
//! `hybrid`. `book_scale_variants` compares ways of cutting passages and of scoring them,
//! directly against the model, to decide what ships. `LORECRAFT_BENCH_SHAPES=all` compares
//! every way of cutting, and `LORECRAFT_BENCH_SHOW=<question number>` prints what outranks one
//! passage. `LORECRAFT_BENCH_OTHER_MODEL=<folder>` measures another model of the same family,
//! with `LORECRAFT_BENCH_POOLING=first` and `LORECRAFT_BENCH_QUERY_PREFIX` for BGE models.
//!
//! What it found, in the first place, the first five and the first ten, of 14:
//!
//! - Before: passages of 25 words with 8 words of overlap, plain cosine: 3, 5, 5.
//! - The overlap was most of the trouble. Without it: 7, 7, 7.
//! - Then measuring from the middle of the book (`search::Centering`), and 18 words: 8, 12, 12
//!   through the app. Centering did nothing or harm with the overlap, and helped without it.
//! - Leaving small words out of the question made no steady difference, so they stay.
//! - bge-small-en-v1.5 (MIT, 133 MB, twice as slow to index) did no better, against MiniLM's
//!   10, 12, 12 directly against the model: 9, 10, 10 centered, or 8, 11, 12 without small
//!   words, though that last puts "the knight at the gate" second, which MiniLM always misses.

use std::collections::HashMap;
use std::time::Instant;

use serde_json::{json, Value};

use super::chunk::{chunk_document_shaped, Shape, SHAPE};
use super::search::Centering;
use super::{builtin, Provider};
use crate::engine::Engine;
use crate::rpc::call;

struct Lcg(u32);

impl Lcg {
    /// The E2E test's generator, so the book is the same one.
    fn below(&mut self, n: usize) -> usize {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        ((self.0 as f64 / 4_294_967_296.0) * n as f64) as usize
    }

    fn pick<'a>(&mut self, list: &[&'a str]) -> &'a str {
        list[self.below(list.len())]
    }
}

/// `bookOfWords` in `e2e/meaning.test.mjs`, sentence for sentence.
pub fn book_of_words(total: usize) -> Vec<Vec<String>> {
    let people = ["Lyra", "Tomas", "Old Berrin", "The miller", "Sefa", "Her brother", "The ferryman", "Ansel"];
    let verbs = ["carried", "mended", "counted", "traded", "painted", "sold", "folded", "cleaned", "weighed", "hid"];
    let things = [
        "the fishing nets", "a basket of plums", "the copper kettle", "his winter boots", "the blue wool", "a sack of barley",
        "the ledger", "the old map", "a jar of honey", "the rope",
    ];
    let places = [
        "by the river", "in the market", "under the willow", "at the mill", "along the canal", "in the orchard",
        "behind the bakery", "on the hillside", "near the bridge", "in the attic",
    ];
    let times = [
        "before the rain came", "as the sun went down", "while the bells rang", "early in the spring", "after the long harvest",
        "when the snow melted", "during the fair", "at first light",
    ];
    let thoughts = [
        "Nobody spoke of the money again.",
        "The smell of woodsmoke hung over everything.",
        "It had been a poor year for apples.",
        "She laughed and said it did not matter.",
        "He wondered whether the letter would ever arrive.",
        "The children ran ahead, shouting about the geese.",
        "There was still bread on the table.",
        "The water was higher than anyone remembered.",
    ];
    let mut r = Lcg(12345);
    let mut scenes = Vec::new();
    let mut written = 0;
    while written < total {
        let mut paragraphs = Vec::new();
        let mut words = 0;
        while words < 1000 {
            let sentences = 2 + r.below(5);
            let mut paragraph = String::new();
            for _ in 0..sentences {
                let (a, b, c, d, e) = (r.pick(&people), r.pick(&verbs), r.pick(&things), r.pick(&places), r.pick(&times));
                let thought = r.pick(&thoughts);
                paragraph.push_str(&format!("{a} {b} {c} {d} {e}. {thought} "));
            }
            let paragraph = paragraph.trim().to_string();
            words += paragraph.split_whitespace().count();
            paragraphs.push(paragraph);
        }
        written += words;
        scenes.push(paragraphs);
    }
    scenes
}

/// A question, and the passage that answers it.
pub const PLANTED: [(&str, &str); 14] = [
    ("the knight at the gate", "Aria guarded the northern door. All night she stood there with her spear, and nobody passed her."),
    ("a ship lost in a storm", "The waves rose higher than the masts, and by morning the Swallow had gone under with all her crew."),
    ("someone poisoned the king's wine", "Ansel tipped the vial of nightshade into the royal cup while the old man was looking away."),
    ("a wedding feast", "The bride wore her mother's veil, and the tables groaned under roast goose and sweet cakes until midnight."),
    ("afraid of the dark", "Even grown, Sefa could not sleep unless a candle burned beside her bed, because the black corners of the room still frightened her."),
    ("a dragon attacked the village", "Fire rained from the great wings, and by dawn every thatched roof in Millbrook was ash."),
    ("learning to read", "Old Berrin traced each letter with his finger, sounding out the words of the primer one slow syllable at a time."),
    ("a secret tunnel under the castle", "Behind the tapestry a narrow stair went down into the rock, far below the fortress walls, to a passage nobody had mapped."),
    ("the healer saved the sick child", "The herb woman pressed willow bark and honey to the boy's lips, and by morning his fever had broken."),
    ("a sword fight at dawn", "At first light the two men faced each other on the frozen field, blades drawn, while their seconds looked on."),
    ("betrayed by a friend", "Tomas had trusted him for twenty years, and still he sold their hiding place to the soldiers for a handful of silver."),
    ("grief after a funeral", "When the last mourner had gone, Lyra sat alone by the fresh grave and wept until her voice gave out."),
    ("the crown of Eldoria", "The crown of Eldoria was lost the night the old queen died, and no smith since has been able to copy it."),
    ("where the old map was hidden", "The old map was hidden beneath the floorboards of the chapel, wrapped in oilcloth."),
];

/// The book with every passage planted, and the scene each went into.
pub fn planted_book() -> (Vec<Vec<String>>, Vec<usize>) {
    let mut scenes = book_of_words(100_000);
    let n = scenes.len();
    let mut targets = Vec::new();
    for (i, (_, passage)) in PLANTED.iter().enumerate() {
        // The first goes where the E2E test puts it.
        let scene = (n / 2 + i * 7) % n;
        scenes[scene].insert(3, passage.to_string());
        targets.push(scene);
    }
    (scenes, targets)
}

/// Whether a snippet shows some of the passage: any of its sentences, or its start.
fn shows(snippet: &str, passage: &str) -> bool {
    passage.split(". ").map(|s| s.trim_end_matches('.')).filter(|s| s.len() >= 12).any(|s| snippet.contains(s))
}

#[derive(Default)]
struct Recall {
    places: Vec<Option<usize>>,
    /// The passage's score and the tenth scene's, where known, to set the lowest score shown.
    scores: Vec<(f32, f32)>,
}

impl Recall {
    fn add(&mut self, place: Option<usize>) {
        self.places.push(place);
    }

    fn line(&self, name: &str) -> String {
        let within = |n: usize| self.places.iter().filter(|p| p.is_some_and(|p| p < n)).count();
        let total = self.places.len();
        let places: Vec<String> = self.places.iter().map(|p| p.map_or("-".to_string(), |p| (p + 1).to_string())).collect();
        let mut line = format!(
            "{name:<44} top 1: {:>2}/{total}  top 5: {:>2}/{total}  top 10: {:>2}/{total}   places: {}",
            within(1),
            within(5),
            within(10),
            places.join(" ")
        );
        if !self.scores.is_empty() {
            let lowest = |pick: fn(&(f32, f32)) -> f32| self.scores.iter().map(pick).fold(f32::INFINITY, f32::min);
            let mean = |pick: fn(&(f32, f32)) -> f32| self.scores.iter().map(pick).sum::<f32>() / self.scores.len() as f32;
            line.push_str(&format!(
                "\n{:<44} passage scores: lowest {:.3}, mean {:.3}; tenth scene: lowest {:.3}, mean {:.3}",
                "",
                lowest(|s| s.0),
                mean(|s| s.0),
                lowest(|s| s.1),
                mean(|s| s.1)
            ));
        }
        line
    }
}

fn model_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("LORECRAFT_MODEL_DIR").expect("LORECRAFT_MODEL_DIR"))
}

fn doc(paragraphs: &[String]) -> Value {
    let content: Vec<Value> = paragraphs.iter().map(|p| json!({ "type": "paragraph", "content": [{ "type": "text", "text": p }] })).collect();
    json!({ "type": "doc", "content": content })
}

/// A project holding the book, one scene per element. Returns the scenes' ids.
fn project_with(engine: &Engine, scenes: &[Vec<String>]) -> Vec<String> {
    call(engine, "project.new", json!({}));
    let books = call(engine, "books.list", json!({}));
    let book = books[0]["id"].clone();
    let tree = call(engine, "nodes.tree", json!({ "bookId": book }));
    let chapter = tree.as_array().unwrap().iter().find(|n| n["kind"] == "chapter").unwrap()["id"].clone();
    // The project starts with an empty scene, which stays out of the way.
    scenes
        .iter()
        .enumerate()
        .map(|(i, paragraphs)| {
            let scene = call(engine, "nodes.create", json!({ "bookId": book, "parentId": chapter, "kind": "scene", "title": format!("Scene {}", i + 1) }));
            call(engine, "nodes.update", json!({ "id": scene["id"], "patch": { "content": doc(paragraphs) } }));
            scene["id"].as_str().unwrap().to_string()
        })
        .collect()
}

fn copy_model_into(engine: &Engine) {
    let dir = builtin::model_dir(&engine.paths.root);
    std::fs::create_dir_all(&dir).unwrap();
    for spec in builtin::FILES {
        std::fs::copy(model_dir().join(spec.name), dir.join(spec.name)).unwrap();
    }
}

/// Where each question's passage is shown, in a list of results.
fn place_in(results: &Value, target: &str, passage: &str) -> Option<usize> {
    results
        .as_array()
        .unwrap()
        .iter()
        .position(|hit| hit["id"] == target && shows(hit["snippet"].as_str().unwrap_or(""), passage))
}

#[test]
#[ignore = "needs the downloaded model, in LORECRAFT_MODEL_DIR, and takes minutes"]
fn book_scale_through_the_app() {
    let (scenes, targets) = planted_book();
    let words: usize = scenes.iter().flatten().map(|p| p.split_whitespace().count()).sum();
    let (engine, _host, _dir) = Engine::for_test();
    copy_model_into(&engine);
    let ids = project_with(&engine, &scenes);
    call(&engine, "settings.update", json!({ "patch": { "ai": { "embeddings": { "enabled": true, "source": "builtin" } } } }));

    let start = Instant::now();
    let mut status = Value::Null;
    for _ in 0..100_000 {
        status = call(&engine, "embeddings.step", json!({}));
        if status["state"] != "indexing" {
            break;
        }
    }
    let seconds = start.elapsed().as_secs_f64();
    assert_eq!(status["state"], "ready", "{status}");
    println!(
        "\nIndexed {words} words as {} passages in {seconds:.1} s, {:.1} ms per passage, {:.0} words a second.",
        status["done"],
        seconds * 1000.0 / status["embedded"].as_f64().unwrap(),
        words as f64 / seconds
    );

    let mut meaning = Recall::default();
    let mut hybrid = Recall::default();
    let start = Instant::now();
    for (i, (question, passage)) in PLANTED.iter().enumerate() {
        let hits = call(&engine, "embeddings.search", json!({ "q": question, "limit": 10 }));
        meaning.add(place_in(&hits, &ids[targets[i]], passage));
        let merged = call(&engine, "embeddings.hybrid", json!({ "q": question, "limit": 10 }));
        hybrid.add(place_in(&merged["results"], &ids[targets[i]], passage));
    }
    println!("{} searches of each kind in {:?}", PLANTED.len(), start.elapsed());
    println!("{}", meaning.line("embeddings.search"));
    println!("{}", hybrid.line("embeddings.hybrid"));
    println!("{}", Recall { places: meaning.places[..12].to_vec(), scores: Vec::new() }.line("embeddings.search, no words in common"));
}

// ---- Variants, directly against the model ----------------------------------------------------

struct Embedded {
    dimensions: usize,
    vectors: Vec<f32>,
    /// The scene of each passage.
    scene: Vec<usize>,
    /// The text of each passage as a reader sees it.
    snippet: Vec<String>,
}

fn embed_book(provider: &dyn Provider, scenes: &[Vec<String>], shape: Shape, known: &mut HashMap<String, Vec<f32>>) -> (Embedded, f64, usize) {
    let mut texts = Vec::new();
    let mut scene_of = Vec::new();
    let mut snippets = Vec::new();
    for (i, paragraphs) in scenes.iter().enumerate() {
        for chunk in chunk_document_shaped(shape, None, &format!("\n{}", paragraphs.join("\n"))) {
            texts.push(chunk.text);
            snippets.push(chunk.snippet);
            scene_of.push(i);
        }
    }
    let missing: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        texts.iter().filter(|t| !known.contains_key(*t) && seen.insert((*t).clone())).cloned().collect()
    };
    let start = Instant::now();
    for batch in missing.chunks(64) {
        let vectors = provider.embed(batch).unwrap();
        for (text, vector) in batch.iter().zip(vectors) {
            known.insert(text.clone(), vector);
        }
    }
    let seconds = start.elapsed().as_secs_f64();
    let dimensions = known.values().next().map_or(0, Vec::len);
    let vectors = texts.iter().flat_map(|t| known[t].iter().copied()).collect();
    (Embedded { dimensions, vectors, scene: scene_of, snippet: snippets }, seconds, missing.len())
}

/// The place of each question's passage, best first and one passage per scene, as `search` does.
fn ranks(embedded: &Embedded, queries: &[Vec<f32>], targets: &[usize], centering: Option<&Centering>) -> Recall {
    let mut recall = Recall::default();
    let mut scores = Vec::new();
    for (i, query) in queries.iter().enumerate() {
        lorecraft_minilm::score_all(query, &embedded.vectors, &mut scores);
        if let Some(centering) = centering {
            centering.adjust(query, &mut scores);
        }
        let mut order: Vec<usize> = (0..scores.len()).collect();
        order.sort_unstable_by(|&a, &b| scores[b].total_cmp(&scores[a]));
        if std::env::var("LORECRAFT_BENCH_SHOW").is_ok_and(|v| v == i.to_string()) {
            for &row in order.iter().take(5) {
                println!("    {:.3}  {}", scores[row], embedded.snippet[row]);
            }
            for (row, snippet) in embedded.snippet.iter().enumerate() {
                if embedded.scene[row] == targets[i] && shows(snippet, PLANTED[i].1) {
                    let place = order.iter().position(|&r| r == row).unwrap();
                    println!("    {:.3}  at passage {}: {snippet}", scores[row], place + 1);
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        let mut place = None;
        let mut target_score = f32::NAN;
        let mut tenth = f32::NAN;
        for row in order {
            let scene = embedded.scene[row];
            if !seen.insert(scene) {
                continue;
            }
            if seen.len() == 10 {
                tenth = scores[row];
            }
            if scene == targets[i] && target_score.is_nan() {
                if shows(&embedded.snippet[row], PLANTED[i].1) {
                    place = Some(seen.len() - 1);
                }
                target_score = scores[row];
            }
            if seen.len() >= 10 && !target_score.is_nan() {
                break;
            }
        }
        recall.add(place);
        if !target_score.is_nan() && !tenth.is_nan() {
            recall.scores.push((target_score, tenth));
        }
    }
    recall
}

#[test]
#[ignore = "needs the downloaded model, in LORECRAFT_MODEL_DIR, and takes minutes"]
fn book_scale_variants() {
    let (scenes, targets) = planted_book();
    let (engine, _host, _dir) = Engine::for_test();
    copy_model_into(&engine);
    // Another model of the same family can be measured instead, from its own folder.
    let provider: Box<dyn Provider> = match std::env::var("LORECRAFT_BENCH_OTHER_MODEL") {
        Ok(dir) => {
            let mut loaded = builtin::load_from(std::path::Path::new(&dir)).unwrap();
            if std::env::var("LORECRAFT_BENCH_POOLING").is_ok_and(|p| p == "first") {
                loaded.bert = loaded.bert.with_pooling(lorecraft_minilm::Pooling::First);
            }
            Box::new(builtin::BuiltinProvider::from_loaded(loaded))
        }
        Err(_) => Box::new(builtin::provider(&engine).unwrap()),
    };
    let provider = provider.as_ref();
    let prefix = std::env::var("LORECRAFT_BENCH_QUERY_PREFIX").unwrap_or_default();
    let questions: Vec<String> = PLANTED.iter().map(|(q, _)| q.to_string()).collect();
    let queries = provider.embed(&questions.iter().map(|q| format!("{prefix}{q}")).collect::<Vec<_>>()).unwrap();
    // The same questions without their small words.
    const SMALL: [&str; 16] = ["the", "a", "an", "of", "at", "in", "on", "to", "by", "for", "with", "was", "is", "and", "or", "where"];
    let stripped: Vec<String> = questions
        .iter()
        .map(|q| q.split_whitespace().filter(|w| !SMALL.contains(&w.to_lowercase().as_str())).collect::<Vec<_>>().join(" "))
        .collect();
    let stripped = provider.embed(&stripped.iter().map(|q| format!("{prefix}{q}")).collect::<Vec<_>>()).unwrap();

    // The first is what ships and the second what shipped before. The rest only when asked.
    let mut shapes: Vec<(&str, Shape)> = vec![
        ("18 words, no overlap (ships)", SHAPE),
        ("25 words, overlap 8 (before)", Shape { target: 25, max: 60, overlap: 8 }),
        ("25 words, no overlap", Shape { target: 25, max: 60, overlap: 0 }),
        ("12 words, overlap 4", Shape { target: 12, max: 40, overlap: 4 }),
        ("12 words, no overlap", Shape { target: 12, max: 40, overlap: 0 }),
        ("8 words, no overlap", Shape { target: 8, max: 30, overlap: 0 }),
        ("50 words, overlap 8", Shape { target: 50, max: 90, overlap: 8 }),
    ];
    if !std::env::var("LORECRAFT_BENCH_SHAPES").is_ok_and(|v| v == "all") {
        shapes.truncate(2);
    }
    let mut known = HashMap::new();
    for (name, shape) in shapes {
        let (embedded, seconds, count) = embed_book(provider, &scenes, shape, &mut known);
        println!("\n{name}: {} passages, {count} embedded in {seconds:.1} s", embedded.scene.len());
        println!("{}", ranks(&embedded, &queries, &targets, None).line("  cosine"));
        let centering = Centering::of(&embedded.vectors, embedded.dimensions);
        println!("{}", ranks(&embedded, &queries, &targets, Some(&centering)).line("  centered"));
        println!("{}", ranks(&embedded, &stripped, &targets, None).line("  cosine, question without small words"));
        println!("{}", ranks(&embedded, &stripped, &targets, Some(&centering)).line("  centered, question without small words"));
    }
}
