//! Égaliseur paramétrique 8 bandes basé sur des filtres biquad IIR
//!
//! Architecture :
//! - Les gains (f32 encodés en u32 bits) sont partagés via Arc<AtomicU32>
//! - Les filtres biquad vivent dans le callback audio (pas thread-safe)
//! - Les coefficients sont recalculés dans le callback quand un gain change
//! - 0 dB gain = filtre bypassé (pas de traitement, bit-perfect)

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use biquad::{Biquad, Coefficients, DirectForm1, ToHertz, Type, Q_BUTTERWORTH_F32};

/// Nombre de bandes de l'égaliseur
pub const EQ_BAND_COUNT: usize = 8;

/// Fréquences centrales des 8 bandes (Hz)
pub const EQ_FREQUENCIES: [f32; EQ_BAND_COUNT] = [
    32.0, 64.0, 250.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

/// Labels des fréquences pour le frontend
pub const EQ_LABELS: [&str; EQ_BAND_COUNT] = [
    "32", "64", "250", "1k", "2k", "4k", "8k", "16k",
];

/// Gain minimum et maximum en dB
pub const EQ_MIN_DB: f32 = -12.0;
pub const EQ_MAX_DB: f32 = 12.0;

/// Q factor pour les filtres peaking EQ (Butterworth par défaut)
const EQ_Q: f32 = Q_BUTTERWORTH_F32;

/// État partagé de l'EQ (thread-safe, passé via Arc)
/// Les gains sont stockés comme f32::to_bits() dans des AtomicU32
pub struct EqSharedState {
    pub enabled: Arc<AtomicBool>,
    pub gains: [Arc<AtomicU32>; EQ_BAND_COUNT],
}

impl EqSharedState {
    pub fn new() -> Self {
        let zero_bits = f32::to_bits(0.0);
        Self {
            enabled: Arc::new(AtomicBool::new(false)),
            gains: std::array::from_fn(|_| Arc::new(AtomicU32::new(zero_bits))),
        }
    }

    /// Met à jour le gain d'une bande (en dB, clampé à [-12, +12])
    pub fn set_gain(&self, band: usize, gain_db: f32) {
        if band < EQ_BAND_COUNT {
            let clamped = gain_db.clamp(EQ_MIN_DB, EQ_MAX_DB);
            self.gains[band].store(f32::to_bits(clamped), Ordering::Relaxed);
        }
    }

    /// Met à jour tous les gains d'un coup
    pub fn set_all_gains(&self, gains: &[f32]) {
        for (i, &gain) in gains.iter().enumerate().take(EQ_BAND_COUNT) {
            self.set_gain(i, gain);
        }
    }

    /// Lit le gain d'une bande
    pub fn get_gain(&self, band: usize) -> f32 {
        if band < EQ_BAND_COUNT {
            f32::from_bits(self.gains[band].load(Ordering::Relaxed))
        } else {
            0.0
        }
    }

    /// Lit tous les gains
    pub fn get_all_gains(&self) -> [f32; EQ_BAND_COUNT] {
        std::array::from_fn(|i| self.get_gain(i))
    }

    /// Active/désactive l'EQ
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
}

impl Clone for EqSharedState {
    fn clone(&self) -> Self {
        Self {
            enabled: Arc::clone(&self.enabled),
            gains: std::array::from_fn(|i| Arc::clone(&self.gains[i])),
        }
    }
}

/// Filtre biquad stéréo pour une bande de l'EQ
/// Les filtres ont un état interne (z1, z2) qui évolue sample par sample
/// Ils ne sont PAS thread-safe et doivent vivre dans le callback audio
pub struct EqBandFilter {
    filter_l: DirectForm1<f32>,
    filter_r: DirectForm1<f32>,
    current_gain_db: f32,
    freq: f32,
}

impl EqBandFilter {
    fn new(freq: f32, sample_rate: f32) -> Self {
        // Initialise avec un gain de 0 dB (passthrough)
        let coeffs = Self::make_coeffs(freq, 0.0, sample_rate);
        Self {
            filter_l: DirectForm1::<f32>::new(coeffs),
            filter_r: DirectForm1::<f32>::new(coeffs),
            current_gain_db: 0.0,
            freq,
        }
    }

    fn make_coeffs(freq: f32, gain_db: f32, sample_rate: f32) -> Coefficients<f32> {
        // Utilise PeakingEQ pour chaque bande
        // Le gain_db de biquad::Type::PeakingEQ attend un gain linéaire, pas dB
        // Convertissons : gain linéaire = 10^(dB/20)
        let gain_linear = 10.0f32.powf(gain_db / 20.0);
        Coefficients::<f32>::from_params(
            Type::PeakingEQ(gain_linear),
            sample_rate.hz(),
            freq.hz(),
            EQ_Q,
        ).unwrap_or_else(|_| {
            // Fallback : coefficients passthrough
            Coefficients {
                a1: 0.0, a2: 0.0,
                b0: 1.0, b1: 0.0, b2: 0.0,
            }
        })
    }

    /// Met à jour les coefficients si le gain a changé
    /// Retourne true si les coefficients ont été recalculés
    fn update_if_needed(&mut self, new_gain_db: f32, sample_rate: f32) -> bool {
        // Seuil de 0.01 dB pour éviter les recalculs inutiles
        if (new_gain_db - self.current_gain_db).abs() > 0.01 {
            self.current_gain_db = new_gain_db;
            let coeffs = Self::make_coeffs(self.freq, new_gain_db, sample_rate);
            self.filter_l = DirectForm1::<f32>::new(coeffs);
            self.filter_r = DirectForm1::<f32>::new(coeffs);
            true
        } else {
            false
        }
    }

    /// Traite un échantillon stéréo
    #[inline]
    fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        (self.filter_l.run(left), self.filter_r.run(right))
    }
}

/// Processeur EQ complet avec 8 bandes de filtres biquad
/// Vit dans le callback audio (pas thread-safe)
pub struct EqProcessor {
    bands: [EqBandFilter; EQ_BAND_COUNT],
    sample_rate: f32,
}

impl EqProcessor {
    /// Crée un nouveau processeur EQ pour un sample rate donné
    pub fn new(sample_rate: f32) -> Self {
        Self {
            bands: std::array::from_fn(|i| EqBandFilter::new(EQ_FREQUENCIES[i], sample_rate)),
            sample_rate,
        }
    }

    /// Met à jour le sample rate (recalcule tous les coefficients)
    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        if (sample_rate - self.sample_rate).abs() > 0.1 {
            self.sample_rate = sample_rate;
            for band in &mut self.bands {
                let coeffs = EqBandFilter::make_coeffs(band.freq, band.current_gain_db, sample_rate);
                band.filter_l = DirectForm1::<f32>::new(coeffs);
                band.filter_r = DirectForm1::<f32>::new(coeffs);
            }
        }
    }

    /// Traite un buffer interleaved stéréo en place
    /// Lit les gains depuis l'état partagé et applique les filtres
    ///
    /// # Arguments
    /// * `samples` - Buffer interleaved stéréo [L0, R0, L1, R1, ...]
    /// * `frames` - Nombre de frames (chaque frame = 2 samples pour stéréo)
    /// * `shared` - État partagé avec les gains atomiques
    pub fn process_interleaved(
        &mut self,
        samples: &mut [f32],
        frames: usize,
        shared: &EqSharedState,
    ) {
        // Vérifie si l'EQ est activé
        if !shared.is_enabled() {
            return;
        }

        // Lit les gains et met à jour les coefficients si nécessaire
        for (i, band) in self.bands.iter_mut().enumerate() {
            let new_gain = f32::from_bits(shared.gains[i].load(Ordering::Relaxed));
            band.update_if_needed(new_gain, self.sample_rate);
        }

        // Applique les filtres sur chaque frame stéréo
        for frame in 0..frames {
            let l_idx = frame * 2;
            let r_idx = frame * 2 + 1;
            if r_idx >= samples.len() { break; }

            let mut l = samples[l_idx];
            let mut r = samples[r_idx];

            for band in &mut self.bands {
                // Bypass les bandes à 0 dB (bit-perfect quand flat)
                if band.current_gain_db.abs() > 0.01 {
                    let (nl, nr) = band.process(l, r);
                    l = nl;
                    r = nr;
                }
            }

            samples[l_idx] = l;
            samples[r_idx] = r;
        }
    }
}
