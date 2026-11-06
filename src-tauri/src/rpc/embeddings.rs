//! Search by meaning: its status, background indexing one step at a time, the model
//! download, and searching. See `crate::embeddings`.

use serde::Deserialize;
use serde_json::{json, Value};

use super::{parse, unknown};
use crate::embeddings::search::SearchParams;
use crate::embeddings::{builtin, index, search, shared, status, Config};
use crate::engine::Engine;
use crate::error::AppResult;

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "status" => Ok(status(engine)),
        "step" => index::step(engine),
        "cancel" => {
            index::pause(engine);
            Ok(status(engine))
        }
        "resume" => {
            index::resume(engine);
            Ok(status(engine))
        }
        "clear" => {
            index::clear(engine)?;
            Ok(status(engine))
        }
        // Runs until the file is here. The UI asks `status` how far along it is.
        "download" => {
            builtin::download(engine)?;
            Ok(status(engine))
        }
        "cancelDownload" => {
            shared(engine).cancel_download.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(status(engine))
        }
        "removeModel" => {
            builtin::remove(engine)?;
            Ok(status(engine))
        }
        // Whether the chosen provider answers. Sends one short fixed text, nothing else.
        "test" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                profile_id: String,
                model: String,
            }
            let p: P = parse(params)?;
            let config = Config { enabled: true, source: "profile".to_string(), profile_id: p.profile_id, model: p.model, fake_cloud: false };
            let dimensions = index::check_provider(engine, &config)?;
            Ok(json!({ "dimensions": dimensions }))
        }
        "search" => {
            let p: SearchParams = parse(params)?;
            let hits = search::search(engine, &p)?;
            Ok(Value::Array(
                hits.iter()
                    .map(|hit| {
                        json!({
                            "kind": hit.kind,
                            "id": hit.id,
                            "title": hit.title,
                            "bookId": hit.book_id,
                            "snippet": hit.snippet,
                            "score": hit.score,
                        })
                    })
                    .collect(),
            ))
        }
        "hybrid" => {
            let p: SearchParams = parse(params)?;
            search::hybrid(engine, &p)
        }
        _ => Err(unknown(&format!("embeddings.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::transport::tests::{json_reply, serve};
    use crate::embeddings::{to_blob, write_quiet};
    use crate::engine::{Engine, TestDir, TestHost};
    use crate::rpc::{call, dispatch};
    use rusqlite::params;
    use std::sync::Arc;
    use std::time::Instant;

    fn project(settings: Value) -> (Arc<Engine>, Arc<TestHost>, TestDir) {
        let (engine, host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        call(&engine, "settings.update", json!({ "patch": { "ai": { "embeddings": settings } } }));
        (engine, host, dir)
    }

    fn fake() -> (Arc<Engine>, Arc<TestHost>, TestDir) {
        project(json!({ "enabled": true, "source": "fake" }))
    }

    fn doc(text: &str) -> Value {
        let paragraphs: Vec<Value> = text
            .split('\n')
            .map(|p| json!({ "type": "paragraph", "content": [{ "type": "text", "text": p }] }))
            .collect();
        json!({ "type": "doc", "content": paragraphs })
    }

    fn page(engine: &Engine, title: &str, text: &str) -> Value {
        let page = call(engine, "pages.create", json!({ "title": title }));
        call(engine, "pages.update", json!({ "id": page["id"], "patch": { "content": doc(text) } }));
        page
    }

    fn first_scene(engine: &Engine) -> Value {
        let books = call(engine, "books.list", json!({}));
        let tree = call(engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap().clone()
    }

    /// Runs indexing until it has nothing left to do, as the UI's loop does.
    fn index_all(engine: &Engine) -> Value {
        for _ in 0..10_000 {
            let status = call(engine, "embeddings.step", json!({}));
            if status["state"] != "indexing" {
                return status;
            }
        }
        panic!("indexing never finished");
    }

    fn found(engine: &Engine, q: &str) -> Vec<String> {
        call(engine, "embeddings.search", json!({ "q": q }))
            .as_array()
            .unwrap()
            .iter()
            .map(|hit| hit["title"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn a_passage_with_no_words_in_common_is_found_by_meaning() {
        let (engine, _host, _dir) = fake();
        let aria = page(&engine, "Aria", "Aria guarded the northern door.");
        page(&engine, "Soup", "Boil two onions with barley until soft.");
        let status = index_all(&engine);
        assert_eq!(status["state"], "ready");
        assert!(status["done"].as_u64().unwrap() >= 2);
        assert_eq!(status["done"], status["total"]);

        // The words of the question appear nowhere in the project.
        assert!(call(&engine, "search.query", json!({ "q": "the knight at the gate" })).as_array().unwrap().is_empty());
        let hits = call(&engine, "embeddings.search", json!({ "q": "the knight at the gate" }));
        assert_eq!(hits[0]["id"], aria["id"]);
        assert_eq!(hits[0]["kind"], "page");
        assert_eq!(hits[0]["snippet"], "Aria guarded the northern door.");
        assert!(hits[0]["score"].as_f64().unwrap() > 0.5);
    }

    #[test]
    fn results_are_ranked_by_closeness_and_limited_by_kind_and_count() {
        let (engine, _host, _dir) = fake();
        page(&engine, "Exact", "knight gate");
        page(&engine, "Half", "knight onions barley stew");
        page(&engine, "Unrelated", "onions barley stew soup");
        let scene = first_scene(&engine);
        call(&engine, "nodes.update", json!({ "id": scene["id"], "patch": { "content": doc("the sentry watched the portal") } }));
        index_all(&engine);

        let hits = call(&engine, "embeddings.search", json!({ "q": "knight gate" }));
        let scores: Vec<f64> = hits.as_array().unwrap().iter().map(|h| h["score"].as_f64().unwrap()).collect();
        assert!(scores.windows(2).all(|w| w[0] >= w[1]), "best first: {scores:?}");
        // A page's title is part of what is embedded, so the scene is the closest of all.
        let titles = found(&engine, "knight gate");
        assert_eq!(titles[..3], [scene["title"].as_str().unwrap().to_string(), "Exact".to_string(), "Half".to_string()]);
        assert!(!titles.contains(&"Unrelated".to_string()), "below the floor");

        let scenes = call(&engine, "embeddings.search", json!({ "q": "knight gate", "kinds": ["node"] }));
        assert_eq!(scenes.as_array().unwrap().len(), 1);
        assert_eq!(scenes[0]["kind"], "node");
        assert_eq!(scenes[0]["bookId"], scene["bookId"]);
        let pages = call(&engine, "embeddings.search", json!({ "q": "knight gate", "kinds": ["page"], "limit": 1 }));
        assert_eq!(pages.as_array().unwrap().len(), 1);
        assert_eq!(pages[0]["kind"], "page");
    }

    #[test]
    fn one_passage_per_document_unless_more_are_asked_for() {
        let (engine, _host, _dir) = fake();
        let many = (0..4).map(|_| "knight gate ".repeat(60)).collect::<Vec<_>>().join("\n");
        page(&engine, "Long", &many);
        index_all(&engine);
        assert_eq!(call(&engine, "embeddings.search", json!({ "q": "knight gate" })).as_array().unwrap().len(), 1);
        assert!(call(&engine, "embeddings.search", json!({ "q": "knight gate", "perDoc": 3 })).as_array().unwrap().len() >= 2);
    }

    #[test]
    fn only_changed_text_is_embedded_again() {
        let (engine, _host, _dir) = fake();
        let long: Vec<String> = (0..10).map(|i| format!("Paragraph {i} {}", "words ".repeat(40))).collect();
        let page_a = page(&engine, "A", &long.join("\n"));
        page(&engine, "B", "Something else entirely.");
        let first = index_all(&engine);
        let total = first["embedded"].as_u64().unwrap();
        assert_eq!(total, first["done"].as_u64().unwrap());

        // No change, nothing to do.
        assert_eq!(index_all(&engine)["embedded"], total);

        // One paragraph at the end changes: one passage again, the others are left alone.
        let mut edited = long.clone();
        edited[9] = format!("A new ending {}", "fresh ".repeat(40));
        call(&engine, "pages.update", json!({ "id": page_a["id"], "patch": { "content": doc(&edited.join("\n")) } }));
        assert_eq!(index_all(&engine)["embedded"].as_u64().unwrap(), total + 1);

        // Restoring it costs nothing, since those vectors are known already.
        call(&engine, "pages.update", json!({ "id": page_a["id"], "patch": { "content": doc(&long.join("\n")) } }));
        assert_eq!(index_all(&engine)["embedded"].as_u64().unwrap(), total + 1);
    }

    #[test]
    fn deleted_documents_leave_the_results_at_once_and_the_index_at_the_next_step() {
        let (engine, _host, _dir) = fake();
        let aria = page(&engine, "Aria", "Aria guarded the northern door.");
        index_all(&engine);
        let before = index::row_count(&engine).unwrap();
        assert!(before >= 1);
        call(&engine, "pages.delete", json!({ "id": aria["id"] }));
        assert!(found(&engine, "knight gate").is_empty(), "the trash is not searched");
        index_all(&engine);
        assert_eq!(index::row_count(&engine).unwrap(), before - 1);
        // Back from the trash, and known already.
        let embedded = call(&engine, "embeddings.status", json!({}))["embedded"].clone();
        call(&engine, "pages.restore", json!({ "id": aria["id"] }));
        let status = index_all(&engine);
        assert_eq!(status["embedded"], embedded);
        assert_eq!(found(&engine, "knight gate"), vec!["Aria".to_string()]);
    }

    #[test]
    fn a_shorter_document_loses_its_extra_rows() {
        let (engine, _host, _dir) = fake();
        index_all(&engine);
        let seeded = index::row_count(&engine).unwrap();
        let long: Vec<String> = (0..6).map(|i| format!("Paragraph {i} {}", "words ".repeat(110))).collect();
        let p = page(&engine, "A", &long.join("\n"));
        index_all(&engine);
        assert!(index::row_count(&engine).unwrap() >= seeded + 6);
        call(&engine, "pages.update", json!({ "id": p["id"], "patch": { "content": doc("Now it is short.") } }));
        index_all(&engine);
        assert_eq!(index::row_count(&engine).unwrap(), seeded + 1);
    }

    #[test]
    fn changing_the_model_indexes_everything_again() {
        let (engine, _host, _dir) = fake();
        page(&engine, "Aria", "Aria guarded the northern door.");
        let first = index_all(&engine);
        let embedded = first["embedded"].as_u64().unwrap();
        call(&engine, "settings.update", json!({ "patch": { "ai": { "embeddings": { "model": "other" } } } }));
        let second = index_all(&engine);
        assert_eq!(second["embedded"].as_u64().unwrap(), embedded * 2);
        let models: i64 = engine
            .read(|c| Ok(c.query_row("SELECT COUNT(DISTINCT model) FROM embeddings", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(models, 1, "the old model's rows are gone");
    }

    #[test]
    fn indexing_is_off_until_turned_on_and_can_be_stopped() {
        let (engine, _host, _dir) = project(json!({ "enabled": false, "source": "fake" }));
        page(&engine, "Aria", "Aria guarded the northern door.");
        let status = call(&engine, "embeddings.step", json!({}));
        assert_eq!(status["state"], "off");
        assert_eq!(index::row_count(&engine).unwrap(), 0);
        assert!(found(&engine, "knight gate").is_empty());

        call(&engine, "settings.update", json!({ "patch": { "ai": { "embeddings": { "enabled": true } } } }));
        call(&engine, "embeddings.cancel", json!({}));
        let status = call(&engine, "embeddings.step", json!({}));
        assert_eq!(status["state"], "paused");
        assert_eq!(index::row_count(&engine).unwrap(), 0);
        call(&engine, "embeddings.resume", json!({}));
        assert_eq!(index_all(&engine)["state"], "ready");

        // Turned off, the index stays until it is removed.
        let rows = index::row_count(&engine).unwrap();
        assert!(rows >= 1);
        call(&engine, "settings.update", json!({ "patch": { "ai": { "embeddings": { "enabled": false } } } }));
        let status = call(&engine, "embeddings.step", json!({}));
        assert_eq!(status["state"], "off");
        assert_eq!(status["leftoverPassages"], rows);
        let status = call(&engine, "embeddings.clear", json!({}));
        assert_eq!(status["leftoverPassages"], 0);
        assert_eq!(index::row_count(&engine).unwrap(), 0);
        call(&engine, "settings.update", json!({ "patch": { "ai": { "embeddings": { "enabled": true } } } }));
        assert_eq!(index_all(&engine)["state"], "ready");
        assert_eq!(index::row_count(&engine).unwrap(), rows);

        // Stopping applies to this project, not to the next one opened.
        call(&engine, "embeddings.cancel", json!({}));
        assert_eq!(call(&engine, "embeddings.status", json!({}))["state"], "paused");
        call(&engine, "project.close", json!({}));
        call(&engine, "project.new", json!({}));
        assert_eq!(index_all(&engine)["state"], "ready");
    }

    #[test]
    fn indexing_does_not_mark_a_saved_project_as_changed_and_saving_keeps_the_index() {
        let (engine, _host, dir) = fake();
        page(&engine, "Aria", "Aria guarded the northern door.");
        let path = dir.0.join("world.lorecraft");
        engine.allow_path(&path);
        call(&engine, "project.saveAs", json!({ "path": path }));
        assert_eq!(call(&engine, "project.status", json!({}))["dirty"], false);
        let saved_size = std::fs::metadata(&path).unwrap().len();

        index_all(&engine);
        assert!(index::row_count(&engine).unwrap() >= 1);
        assert_eq!(call(&engine, "project.status", json!({}))["dirty"], false, "derived data is not an edit");
        assert_eq!(std::fs::metadata(&path).unwrap().len(), saved_size, "the file is untouched");

        // A real edit, then a save: the index goes with it, and comes back on opening.
        page(&engine, "Soup", "Boil two onions with barley until soft.");
        index_all(&engine);
        call(&engine, "project.save", json!({}));
        call(&engine, "project.close", json!({}));
        call(&engine, "project.open", json!({ "path": path }));
        assert!(index::row_count(&engine).unwrap() >= 2);
        assert_eq!(found(&engine, "knight gate"), vec!["Aria".to_string()]);
    }

    #[test]
    fn work_is_kept_when_a_project_closes_with_nothing_to_save() {
        let (engine, _host, dir) = fake();
        page(&engine, "Aria", "Aria guarded the northern door.");
        let path = dir.0.join("world.lorecraft");
        engine.allow_path(&path);
        call(&engine, "project.saveAs", json!({ "path": path }));

        let first = index_all(&engine);
        let embedded = first["embedded"].clone();
        assert!(embedded.as_u64().unwrap() >= 1);
        call(&engine, "project.close", json!({}));

        // The saved file has no index, since nothing was saved after indexing.
        call(&engine, "project.open", json!({ "path": path }));
        assert_eq!(index::row_count(&engine).unwrap(), 0);
        let second = index_all(&engine);
        assert_eq!(second["embedded"], embedded, "nothing is embedded twice");
        assert_eq!(second["done"], first["done"]);
        assert_eq!(found(&engine, "knight gate"), vec!["Aria".to_string()]);
    }

    #[test]
    fn a_cloud_provider_is_never_given_local_only_text() {
        // First with the stand-in, to learn how many passages a cloud provider may be sent.
        let (engine, _host, _dir) = project(json!({ "enabled": true, "source": "fake", "fakeCloud": true }));
        page(&engine, "Open", "Fine to send.");
        let secret = page(&engine, "Secret", "Never to be sent.");
        engine
            .write(|tx| {
                tx.execute("UPDATE pages SET local_only = 1 WHERE id = ?1", [secret["id"].as_str().unwrap()])?;
                Ok(())
            })
            .unwrap();
        let passages = index_all(&engine)["done"].as_u64().unwrap() as usize;
        let items: Vec<Value> = (0..passages).map(|i| json!({ "index": i, "embedding": [1.0, 0.0] })).collect();
        let server = serve(vec![json_reply("200 OK", "", &json!({ "data": items }).to_string())]);

        call(&engine, "settings.update", json!({ "patch": { "ai": {
            "profiles": [{ "id": "c", "name": "Cloud", "kind": "openai-compatible", "baseUrl": server.url, "isCloud": true }],
            "embeddings": { "source": "profile", "profileId": "c", "model": "embed-small" },
        }}}));
        let status = index_all(&engine);
        assert_eq!(status["state"], "ready", "{status}");
        assert_eq!(status["isCloud"], true);
        assert_eq!(status["skippedLocalOnly"], 1);
        let sent = server.requests.lock().unwrap().join("\n");
        assert!(sent.contains("Fine to send"));
        assert!(!sent.contains("Never to be sent"));
        assert!(!sent.contains("Secret"));
        assert!(sent.contains("\"model\":\"embed-small\""));
        let rows: i64 = engine
            .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM embeddings WHERE entity_id = ?1", [secret["id"].as_str().unwrap()], |r| r.get(0))?))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn a_page_made_local_only_later_leaves_a_cloud_index() {
        let (engine, _host, _dir) = project(json!({ "enabled": true, "source": "fake", "fakeCloud": true }));
        let aria = page(&engine, "Aria", "Aria guarded the northern door.");
        let status = index_all(&engine);
        assert_eq!(status["skippedLocalOnly"], 0);
        assert_eq!(found(&engine, "knight gate"), vec!["Aria".to_string()]);
        engine
            .write(|tx| {
                tx.execute("UPDATE pages SET local_only = 1, updated_at = '2999' WHERE id = ?1", [aria["id"].as_str().unwrap()])?;
                Ok(())
            })
            .unwrap();
        let status = index_all(&engine);
        assert_eq!(status["skippedLocalOnly"], 1);
        assert!(found(&engine, "knight gate").is_empty());
    }

    #[test]
    fn a_local_provider_indexes_local_only_text_but_results_for_a_cloud_model_leave_it_out() {
        let (engine, _host, _dir) = fake();
        let aria = page(&engine, "Aria", "Aria guarded the northern door.");
        engine
            .write(|tx| {
                tx.execute("UPDATE pages SET local_only = 1 WHERE id = ?1", [aria["id"].as_str().unwrap()])?;
                Ok(())
            })
            .unwrap();
        assert_eq!(index_all(&engine)["skippedLocalOnly"], 0);
        assert_eq!(found(&engine, "knight gate"), vec!["Aria".to_string()]);
        let for_cloud = call(&engine, "embeddings.search", json!({ "q": "knight gate", "excludeLocalOnly": true }));
        assert!(for_cloud.as_array().unwrap().is_empty());
        // Found by its title and by meaning, and left out both ways.
        let hybrid = call(&engine, "embeddings.hybrid", json!({ "q": "Aria", "excludeLocalOnly": true }));
        assert!(hybrid["results"].as_array().unwrap().iter().all(|r| r["id"] != aria["id"]), "{hybrid}");
        let everything = call(&engine, "embeddings.hybrid", json!({ "q": "Aria" }));
        assert_eq!(everything["results"][0]["id"], aria["id"]);
    }

    #[test]
    fn hybrid_ranks_what_both_find_first_and_falls_back_to_keywords() {
        let (engine, _host, _dir) = project(json!({ "enabled": false, "source": "fake" }));
        let both = page(&engine, "Keep", "The gate stands where the knight guarded it.");
        let meaning = page(&engine, "Wall", "A sentry watched the portal.");
        let words = page(&engine, "Road", "A gate of carved oak, and barley fields and onions and soup and stew.");

        // With no index it is the keyword search, and says nothing is wrong.
        let plain = call(&engine, "embeddings.hybrid", json!({ "q": "gate" }));
        let ids: Vec<&str> = plain["results"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert!(ids.contains(&both["id"].as_str().unwrap()));
        assert!(ids.contains(&words["id"].as_str().unwrap()));
        assert!(!ids.contains(&meaning["id"].as_str().unwrap()));
        assert_eq!(plain["results"][0]["matchedBy"], json!(["keyword"]));

        call(&engine, "settings.update", json!({ "patch": { "ai": { "embeddings": { "enabled": true } } } }));
        index_all(&engine);
        let merged = call(&engine, "embeddings.hybrid", json!({ "q": "gate" }));
        let results = merged["results"].as_array().unwrap();
        assert_eq!(results[0]["matchedBy"], json!(["keyword", "meaning"]));
        let meaning_only = results.iter().find(|r| r["id"] == meaning["id"]).expect("found by meaning alone");
        assert_eq!(meaning_only["matchedBy"], json!(["meaning"]));
        assert_eq!(meaning_only["snippet"], "A sentry watched the portal.");
    }

    #[test]
    fn a_failing_model_says_why_and_keeps_its_place() {
        let (engine, _host, _dir) = fake();
        let bad = page(&engine, "Bad", "__fail__ this one");
        let status = index_all(&engine);
        assert_eq!(status["state"], "failed");
        assert!(status["message"].as_str().unwrap().contains("told to fail"));
        let rows_before = index::row_count(&engine).unwrap();

        call(&engine, "pages.update", json!({ "id": bad["id"], "patch": { "content": doc("Now it is fine.") } }));
        let status = index_all(&engine);
        assert_eq!(status["state"], "ready");
        assert!(index::row_count(&engine).unwrap() > rows_before);
    }

    #[test]
    fn a_server_with_no_embeddings_endpoint_gets_a_plain_explanation() {
        let server = serve(vec![
            json_reply("404 Not Found", "", ""),
            json_reply("404 Not Found", "", "{\"error\":\"Not Found\"}"),
        ]);
        let (engine, _host, _dir) = project(json!({ "enabled": true, "source": "profile", "profileId": "local", "model": "m" }));
        call(&engine, "settings.update", json!({ "patch": { "ai": { "profiles": [
            { "id": "local", "name": "Local", "kind": "openai-compatible", "baseUrl": server.url, "isCloud": false }
        ]}}}));
        page(&engine, "Aria", "Aria guarded the northern door.");
        let status = index_all(&engine);
        assert_eq!(status["state"], "failed");
        assert!(status["message"].as_str().unwrap().contains("no embeddings service"), "{status}");
        let error = dispatch(&engine, "embeddings.test", json!({ "profileId": "local", "model": "m" })).unwrap_err();
        assert_eq!(error.code, "NO_EMBEDDINGS");
    }

    #[test]
    fn anthropic_is_refused_and_a_missing_key_or_model_is_explained() {
        let (engine, _host, _dir) = project(json!({ "enabled": true, "source": "profile", "profileId": "a", "model": "m" }));
        call(&engine, "settings.update", json!({ "patch": { "ai": { "profiles": [
            { "id": "a", "name": "Claude", "kind": "anthropic", "baseUrl": "https://api.anthropic.com", "isCloud": true },
            { "id": "o", "name": "OpenAI", "kind": "openai", "baseUrl": "http://127.0.0.1:9/v1", "isCloud": true },
        ]}}}));
        assert_eq!(dispatch(&engine, "embeddings.test", json!({ "profileId": "a", "model": "m" })).unwrap_err().code, "NO_EMBEDDINGS");
        assert_eq!(dispatch(&engine, "embeddings.test", json!({ "profileId": "o", "model": "m" })).unwrap_err().code, "NO_KEY");
        let status = call(&engine, "embeddings.step", json!({}));
        assert_eq!(status["state"], "failed");
        call(&engine, "settings.update", json!({ "patch": { "ai": { "embeddings": { "model": "" } } } }));
        let status = call(&engine, "embeddings.status", json!({}));
        assert_eq!(status["state"], "notSetUp");
        assert!(status["message"].as_str().unwrap().contains("model"));
    }

    #[test]
    fn the_built_in_model_is_not_set_up_until_it_has_been_downloaded() {
        let (engine, _host, _dir) = project(json!({ "enabled": true, "source": "builtin" }));
        page(&engine, "Aria", "Aria guarded the northern door.");
        let status = call(&engine, "embeddings.step", json!({}));
        assert_eq!(status["state"], "notSetUp");
        assert_eq!(status["builtinPresent"], false);
        assert_eq!(status["downloadTotal"], builtin::total_bytes());
        assert!(found(&engine, "knight gate").is_empty());
        assert_eq!(index::row_count(&engine).unwrap(), 0);
    }

    #[test]
    fn a_damaged_model_is_reported_and_can_be_removed() {
        let (engine, _host, _dir) = project(json!({ "enabled": true, "source": "builtin" }));
        let dir = builtin::model_dir(&engine.paths.root);
        std::fs::create_dir_all(&dir).unwrap();
        for spec in builtin::FILES {
            // The right size, so it counts as present, but not a real model.
            std::fs::File::create(dir.join(spec.name)).unwrap().set_len(spec.bytes).unwrap();
        }
        let status = call(&engine, "embeddings.step", json!({}));
        assert_eq!(status["state"], "failed");
        assert!(status["message"].as_str().unwrap().contains("could not be read") || status["message"].as_str().unwrap().contains("damaged"), "{status}");

        let status = call(&engine, "embeddings.removeModel", json!({}));
        assert_eq!(status["builtinPresent"], false);
        assert!(!dir.exists());
        call(&engine, "embeddings.resume", json!({}));
        assert_eq!(call(&engine, "embeddings.step", json!({}))["state"], "notSetUp");
    }

    #[test]
    fn opening_another_project_starts_afresh() {
        let (engine, _host, _dir) = fake();
        page(&engine, "Aria", "Aria guarded the northern door.");
        index_all(&engine);
        call(&engine, "project.close", json!({}));
        call(&engine, "project.new", json!({}));
        assert!(found(&engine, "knight gate").is_empty());
        let status = index_all(&engine);
        assert_eq!(status["state"], "ready");
        page(&engine, "Lyra", "A sentry watched the portal.");
        index_all(&engine);
        assert_eq!(found(&engine, "knight gate"), vec!["Lyra".to_string()]);
    }

    fn pseudo_random_unit_vector(seed: usize, dimensions: usize) -> Vec<f32> {
        let mut state = (seed as u32).wrapping_mul(2_654_435_761).wrapping_add(1) | 1;
        let mut vector: Vec<f32> = (0..dimensions)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state as f32 / u32::MAX as f32) - 0.5
            })
            .collect();
        crate::embeddings::normalize(&mut vector);
        vector
    }

    /// The figures in the report came from this.
    /// `cargo test --lib searching_100k_chunks -- --ignored --nocapture`
    #[test]
    #[ignore = "a measurement, which takes a few seconds"]
    fn searching_100k_chunks() {
        let (engine, _host, dir) = fake();
        const ROWS: usize = 100_000;
        let snippet = "A passage of about the usual length. ".repeat(16);
        // 1,536 bytes per vector, the size of the built-in model's. The first is a real page.
        let aria = page(&engine, "Aria", "Aria guarded the northern door.");
        index_all(&engine);
        let aria_id = aria["id"].as_str().unwrap().to_string();
        let model = crate::embeddings::fake::MODEL;
        let start = Instant::now();
        write_quiet(&engine, |tx| {
            tx.execute("DELETE FROM embeddings", [])?;
            let mut insert = tx.prepare(
                "INSERT INTO embeddings (entity_kind, entity_id, chunk_index, content_hash, model, vector, snippet) VALUES ('page', ?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for i in 0..ROWS {
                insert.execute(params![aria_id, i as i64, format!("h{i}"), model, to_blob(&pseudo_random_unit_vector(i, 384)), snippet])?;
            }
            Ok(())
        })
        .unwrap();
        println!("wrote {ROWS} rows in {:?}", start.elapsed());
        crate::embeddings::shared(&engine).touched();

        // Directly against the vectors, since the stand-in's own vectors have another size.
        let mut scores = Vec::new();
        let vectors: Vec<f32> = (0..ROWS).flat_map(|i| pseudo_random_unit_vector(i, 384)).collect();
        let query = pseudo_random_unit_vector(ROWS + 1, 384);
        for _ in 0..3 {
            let start = Instant::now();
            lorecraft_minilm::score_all(&query, &vectors, &mut scores);
            let mut order: Vec<usize> = (0..ROWS).collect();
            order.sort_unstable_by(|&a, &b| scores[b].total_cmp(&scores[a]));
            println!("scoring and sorting {ROWS} chunks: {:?}, best {}", start.elapsed(), scores[order[0]]);
        }

        let path = dir.0.join("big.lorecraft");
        engine.allow_path(&path);
        let start = Instant::now();
        call(&engine, "project.saveAs", json!({ "path": path }));
        println!(
            "saving with {ROWS} chunks: {:?}, {} MB",
            start.elapsed(),
            std::fs::metadata(&path).unwrap().len() / 1_000_000
        );
        write_quiet(&engine, |tx| {
            tx.execute("DELETE FROM embeddings", [])?;
            Ok(())
        })
        .unwrap();
        call(&engine, "pages.update", json!({ "id": aria["id"], "patch": { "summary": "edited" } }));
        let start = Instant::now();
        call(&engine, "project.save", json!({}));
        println!(
            "saving with no index: {:?}, {} MB",
            start.elapsed(),
            std::fs::metadata(&path).unwrap().len() / 1_000_000
        );
    }
}
