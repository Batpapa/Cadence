mod heuristic;
mod nw;
pub mod nw_simd;

use crate::decode;
use crate::ff_config;
use crate::index::schema::*;
use crate::index::TuneIndex;
use fnv::FnvHashSet as HashSet;
use serde::Serialize;
use std::collections::HashMap;
use std::fmt;

pub struct QueryEngine {
    pub tune_index: Option<TuneIndex>,
    setting_ids_by_tune_id: HashMap<TuneID, Vec<SettingID>>,
    num_repass: usize,
    num_output: usize,
}

#[derive(Debug, Serialize)]
pub struct TranscriptionQueryRecord {
    pub setting_id: SettingID,
    pub setting: Setting,
    pub display_name: String,
    pub score: f32,
}

#[derive(Debug, Serialize)]
pub struct NameQueryRecord {
    pub setting: Setting,
    pub display_name: String,
}

pub type TranscriptionQueryResults = Vec<TranscriptionQueryRecord>;
pub type NameQueryResults = Vec<NameQueryRecord>;

impl QueryEngine {
    pub fn new() -> QueryEngine {
        QueryEngine {
            tune_index: None,
            setting_ids_by_tune_id: HashMap::new(),
            num_repass: ff_config::QUERY_REPASS_SIZE,
            num_output: 100,
        }
    }

    pub fn use_tune_index(&mut self, tune_index: TuneIndex) {
        // Build tune-IDs to setting-IDs map
        let mut setting_ids_by_tune_id: HashMap<TuneID, Vec<SettingID>> = HashMap::new();
        for (setting_id, setting) in &tune_index.settings {
            setting_ids_by_tune_id
                .entry(setting.tune_id.clone())
                .or_insert(Vec::new())
                .push(setting_id.clone());
        }

        for (_, setting_ids) in setting_ids_by_tune_id.iter_mut() {
            setting_ids.sort_by_key(|k| k.parse::<i32>().unwrap());
        }

        self.setting_ids_by_tune_id = setting_ids_by_tune_id;
        self.tune_index = Some(tune_index);
    }

    pub fn run_contour_query(
        self: &Self,
        contour: &decode::types::ContourString,
    ) -> Result<TranscriptionQueryResults, QueryError> {
        match &self.tune_index {
            None => Err(QueryError),
            Some(tune_index) => {
                //
                // === Heuristic search ===
                // First pass: fast, but inaccurate. Good for eliminating many poor candidates.
                //
                // let nowh = Instant::now();
                let first_search =
                    heuristic::run_transcription_query(&contour, &tune_index, self.num_repass);
                    // eprintln!("Heuristic search took {:.2?}", nowh.elapsed());
                //
                // === Full search ===
                // Second pass: slow, but accurate. Good for refining a shortlist of candidates.
                //
                // let nowf = Instant::now();
                // Alignments run four at a time (see nw_simd.rs) — same
                // arithmetic, four lanes of one v128, ~4x the throughput on a
                // loop that is latency-bound rather than throughput-bound.
                //
                // Two constraints shape the batching:
                //   * every lane must share one `n`, so only settings at least
                //     as long as the query can be batched; the rest go scalar.
                //   * the SORTED ORDER BELOW IS STABLE, so ties keep the order
                //     scores were collected in — which the deduplication then
                //     turns into which setting represents a tune. Batches are
                //     therefore built by length (to keep the lanes in step) but
                //     scores are written back at their ORIGINAL index, so the
                //     collection order is bit-for-bit what it always was.
                let n_query = contour.len();
                let mut second_search: Vec<(SettingID, f32)> = first_search
                    .iter()
                    .map(|(id, _)| ((*id).clone(), 0.0f32))
                    .collect();

                let mut batchable: Vec<usize> = Vec::with_capacity(first_search.len());
                for (i, (setting_id, _)) in first_search.iter().enumerate() {
                    if tune_index.settings[*setting_id].contour.len() >= n_query && n_query > 0 {
                        batchable.push(i);
                    } else {
                        second_search[i].1 = nw::needleman_wunsch(
                            &contour,
                            &tune_index.settings[*setting_id].contour,
                        );
                    }
                }
                // Group by length so the four lanes finish within a few rows of
                // each other; the masked tail is what a mismatched batch costs.
                // Unstable is fine and ~30 KB smaller than the stable sort:
                // scores are written back at their original index, so how the
                // batches happen to be grouped cannot reach the output.
                batchable.sort_unstable_by_key(|&i| {
                    tune_index.settings[first_search[i].0].contour.len()
                });

                let mut c = batchable.chunks_exact(4);
                for chunk in &mut c {
                    let bs = [
                        &tune_index.settings[first_search[chunk[0]].0].contour,
                        &tune_index.settings[first_search[chunk[1]].0].contour,
                        &tune_index.settings[first_search[chunk[2]].0].contour,
                        &tune_index.settings[first_search[chunk[3]].0].contour,
                    ];
                    let scores = nw_simd::needleman_wunsch_x4(&contour, bs);
                    for k in 0..4 {
                        second_search[chunk[k]].1 = scores[k];
                    }
                }
                for &i in c.remainder() {
                    second_search[i].1 = nw::needleman_wunsch(
                        &contour,
                        &tune_index.settings[first_search[i].0].contour,
                    );
                }
                let mut sorted_rankings: Vec<_> = second_search.into_iter().collect();
                sorted_rankings.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap());
                let mut results: TranscriptionQueryResults = Vec::new();

                let mut tune_ids_in_results: HashSet<TuneID> = HashSet::default();

                for (setting_id, score) in sorted_rankings.iter() {
                    let setting = &tune_index.settings[setting_id];
                    if tune_ids_in_results.contains(&setting.tune_id) {
                        continue;
                    }

                    tune_ids_in_results.insert(setting.tune_id.clone());
                    results.push(TranscriptionQueryRecord {
                        setting_id: setting_id.clone(),
                        setting: setting.clone(),
                        score: *score,
                        display_name: tune_index.aliases.get(&setting.tune_id).unwrap()[0].clone(),
                    });

                    if results.len() >= self.num_output {
                        break;
                    }
                }

                // eprintln!("Full search took {:.2?}", nowf.elapsed());
                Ok(results)
            }
        }
    }

    pub fn run_name_query(self: &Self, query: &String) -> Result<NameQueryResults, QueryError> {
        match &self.tune_index {
            None => Err(QueryError),
            Some(tune_index) => {
                let mut scored_names: Vec<heuristic::ScoredName> =
                    heuristic::run_name_query(query, &tune_index);

                // scored_names.sort_unstable_by(|a, b| b.ngram_score.partial_cmp(&a.ngram_score).unwrap());

                scored_names.sort_unstable_by(|a, b| match b.ngram_score.partial_cmp(&a.ngram_score).unwrap() {
                    std::cmp::Ordering::Less => std::cmp::Ordering::Less,
                    std::cmp::Ordering::Greater => std::cmp::Ordering::Greater,
                    std::cmp::Ordering::Equal => {
                        let a_alias_len =
                            &tune_index.aliases.get(&a.tune_id).unwrap()[a.alias_index].len();
                        let b_alias_len =
                            &tune_index.aliases.get(&b.tune_id).unwrap()[b.alias_index].len();
                        return a_alias_len.cmp(&b_alias_len);
                    }
                });

                let mut tune_ids_in_results: HashSet<TuneID> = HashSet::default();

                let top_scores: NameQueryResults = scored_names
                    .iter()
                    .filter(|t| tune_ids_in_results.insert(t.tune_id.clone()))
                    .take(20)
                    .map(|t| {
                        NameQueryRecord {
                            // TODO safer checks in index builder that there can
                            //  never be an alias without a corresponding setting
                            setting: tune_index
                                .settings
                                .get(&self.setting_ids_from_tune_id(t.tune_id.clone()).unwrap()[0])
                                .unwrap()
                                .clone(),
                            display_name: tune_index.aliases.get(&t.tune_id).unwrap()
                                [t.alias_index]
                                .clone(),
                        }
                    })
                    .collect();

                return Ok(top_scores);
            }
        }
    }

    pub fn setting_ids_from_tune_id(&self, tune_id: TuneID) -> Result<&Vec<SettingID>, QueryError> {
        Ok(self
            .setting_ids_by_tune_id
            .get(&tune_id)
            .ok_or(format!("missing tune ID {}", tune_id))
            .unwrap())
    }

    pub fn settings_from_tune_id(
        &self,
        tune_id: TuneID,
    ) -> Result<Vec<(SettingID, Setting)>, QueryError> {
        let tune_index = self.tune_index.as_ref();
        Ok(self
            .setting_ids_from_tune_id(tune_id)?
            .iter()
            .map(|setting_id| {
                (
                    setting_id.clone(),
                    tune_index
                        .unwrap()
                        .settings
                        .get(setting_id)
                        .unwrap()
                        .clone(),
                )
            })
            .collect())
    }

    pub fn aliases_from_tune_id(&self, tune_id: TuneID) -> Result<Vec<String>, QueryError> {
        Ok(self
            .tune_index
            .as_ref()
            .unwrap()
            .aliases
            .get(&tune_id)
            .ok_or(format!("missing tune ID {}", tune_id))
            .unwrap()
            .to_vec())
    }
}

pub struct QueryError;

impl fmt::Debug for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "query engine has not loaded index")
    }
}
