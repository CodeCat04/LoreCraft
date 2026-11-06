//! A timing check on a project the size of a long series. It is ignored by default, since it
//! takes a while. Run it with
//! `cargo test --release --lib indexing::bench -- --ignored --nocapture`.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::engine::Engine;
use crate::rpc::call;
use crate::rpc::manuscript::{create_node, CreateNode};
use crate::rpc::pages::{create_page, CreateInput};

const PAGES: usize = 5_000;
const SCENES: usize = 3_000;
const WORDS_PER_SCENE: usize = 170;
const SAMPLES: usize = 40;

const FILLER: &[&str] = &[
    "the", "rain", "fell", "over", "harbour", "while", "she", "waited", "by", "old", "gate",
    "and", "thought", "about", "letters", "never", "sent", "across", "grey", "water",
];

fn name(i: usize) -> String {
    format!("Kestrel{i:05}")
}

fn prose(seed: usize, words: usize) -> String {
    let mut out = Vec::with_capacity(words);
    for w in 0..words {
        if w % 25 == 0 {
            out.push(name((seed * 7 + w) % PAGES));
        } else {
            out.push(FILLER[(seed + w) % FILLER.len()].to_string());
        }
    }
    out.join(" ")
}

fn doc(text: &str, link: Option<&str>) -> Value {
    let mut content = vec![json!({ "type": "text", "text": text })];
    if let Some(target) = link {
        content.push(json!({ "type": "text", "text": " " }));
        content.push(json!({ "type": "text", "text": target, "marks": [{ "type": "wikiLink", "attrs": { "target": target } }] }));
    }
    json!({ "type": "doc", "content": [{ "type": "paragraph", "content": content }] })
}

fn report(label: &str, mut times: Vec<Duration>) {
    times.sort();
    let median = times[times.len() / 2];
    let p95 = times[(times.len() * 95 / 100).min(times.len() - 1)];
    println!("{label:<14} median {:>8.1} ms   p95 {:>8.1} ms", ms(median), ms(p95));
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn timed(f: impl FnOnce()) -> Duration {
    let start = Instant::now();
    f();
    start.elapsed()
}

#[test]
#[ignore = "slow: a timing check on a large project"]
fn a_large_project_stays_quick() {
    let (engine, _host, dir) = Engine::for_test();
    call(&engine, "project.new", json!({ "name": "Scale" }));
    let book = call(&engine, "books.create", json!({ "title": "Book One" }));
    let book_id = book["id"].as_str().unwrap().to_string();

    let seed_start = Instant::now();
    let (page_ids, scene_ids) = engine
        .write(|tx| {
            super::defer_mentions(tx, || {
                let mut pages = Vec::new();
                for i in 0..PAGES {
                    let link = (i > 0).then(|| name(i - 1));
                    let text = prose(i, 40);
                    pages.push(create_page(
                        tx,
                        CreateInput {
                            title: name(i),
                            content: Some(doc(&text, link.as_deref())),
                            ..Default::default()
                        },
                    )?);
                }
                let mut scenes = Vec::new();
                let mut chapter = String::new();
                for i in 0..SCENES {
                    if i % 20 == 0 {
                        chapter = create_node(
                            tx,
                            CreateNode {
                                book_id: book_id.clone(),
                                parent_id: None,
                                kind: "chapter".into(),
                                title: format!("Chapter {}", i / 20 + 1),
                                after_id: None,
                                content: None,
                                synopsis: None,
                                status: None,
                            },
                        )?;
                    }
                    let text = prose(i, WORDS_PER_SCENE);
                    scenes.push(create_node(
                        tx,
                        CreateNode {
                            book_id: book_id.clone(),
                            parent_id: Some(chapter.clone()),
                            kind: "scene".into(),
                            title: format!("Scene {i}"),
                            after_id: None,
                            content: Some(doc(&text, Some(&name(i % PAGES)))),
                            synopsis: None,
                            status: None,
                        },
                    )?);
                }
                Ok((pages, scenes))
            })
        })
        .unwrap();
    println!(
        "seeded {PAGES} pages and {SCENES} scenes (~{} words) in {:.1} s",
        PAGES * 40 + SCENES * WORDS_PER_SCENE,
        seed_start.elapsed().as_secs_f64()
    );

    let mut page_times = Vec::new();
    for s in 0..SAMPLES {
        let id = &page_ids[(s * 97) % PAGES];
        let content = doc(&format!("{} edit {s}", prose(s, 60)), None);
        page_times.push(timed(|| {
            call(&engine, "pages.update", json!({ "id": id, "patch": { "content": content }, "fromEditor": true }));
        }));
    }
    report("page write", page_times);

    let mut scene_times = Vec::new();
    for s in 0..SAMPLES {
        let id = &scene_ids[(s * 53) % SCENES];
        let content = doc(&format!("{} edit {s}", prose(s, WORDS_PER_SCENE)), None);
        scene_times.push(timed(|| {
            call(&engine, "nodes.update", json!({ "id": id, "patch": { "content": content } }));
        }));
    }
    report("scene write", scene_times);

    let mut rename_times = Vec::new();
    for s in 0..5 {
        let id = &page_ids[(s * 911 + 13) % PAGES];
        rename_times.push(timed(|| {
            call(&engine, "pages.rename", json!({ "id": id, "newTitle": format!("Renamed{s:03}") }));
        }));
    }
    report("rename", rename_times);

    let mut search_times = Vec::new();
    for s in 0..SAMPLES {
        let query = FILLER[s % FILLER.len()];
        search_times.push(timed(|| {
            call(&engine, "search.query", json!({ "q": query }));
        }));
    }
    report("search", search_times);

    let file = dir.0.join("scale.lorecraft");
    engine.allow_path(&file);
    let first_save = timed(|| {
        call(&engine, "project.saveAs", json!({ "path": file }));
    });
    call(&engine, "pages.update", json!({ "id": page_ids[1], "patch": { "content": doc("small change", None) } }));
    let save = timed(|| {
        call(&engine, "project.save", json!({}));
    });
    println!("save as        {:>8.1} ms", ms(first_save));
    println!("save           {:>8.1} ms", ms(save));
}
