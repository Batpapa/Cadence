mod beam_search;
mod contour;
mod octave;
mod pitch_model;
pub mod types;

use crate::feature::types::Features;
use crate::feature::signal;
use std::fmt;
use types::{Contour, ContourString, LatticePath};
pub use contour::{set_tempo_range, ContourDebugFeatures, TempoCandidateScore};

pub struct FeatureDecoder {
    pub sample_rate: u32
}

#[derive(Debug, Clone)]
pub struct DecoderError;

impl fmt::Display for DecoderError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Error decoding features")
    }
}

impl FeatureDecoder {
    pub fn new(sample_rate: u32) -> Result<FeatureDecoder, signal::SampleRateError> {
        if !signal::validate_sample_rate(&sample_rate) {
            return Err(signal::SampleRateError);
        }
        
        Ok(FeatureDecoder {
            sample_rate: sample_rate
        })
    }

    pub fn decode_lattice_path(
        &self,
        features: &mut Features,
    ) -> Result<LatticePath, DecoderError> {
        beam_search::decode(features)
    }

    pub fn decode_contour(
        &self,
        lattice_path: &LatticePath,
        features: &Features
    ) -> Result<ContourString, DecoderError> {
        let mut contour: Contour = contour::contour_from_lattice_path(lattice_path, features, self.sample_rate)?;
        octave::correct_contour_octave(&mut contour);
        return Ok(types::contour_to_contour_string(&contour));
    }

    // Debug/experimental instrumentation (2026-08-18) — same computation as
    // `decode_contour`, additionally surfacing the note/tempo features that
    // are otherwise discarded. Never called from the production transcribe
    // path (`transcribe_pcm_buffer`); see `lib.rs`'s `transcribe_pcm_buffer_debug`.
    pub fn decode_contour_debug(
        &self,
        lattice_path: &LatticePath,
        features: &Features
    ) -> Result<(ContourString, ContourDebugFeatures), DecoderError> {
        let (mut contour, debug) = contour::contour_from_lattice_path_debug(lattice_path, features, self.sample_rate)?;
        octave::correct_contour_octave(&mut contour);
        return Ok((types::contour_to_contour_string(&contour), debug));
    }
}
