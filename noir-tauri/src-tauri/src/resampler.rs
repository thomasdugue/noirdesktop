// === RESAMPLER AUDIO ===
// Wrapper autour de rubato pour resampling haute qualité FFT
// Utilisé quand le DAC ne supporte pas le sample rate natif du fichier

use rubato::{FftFixedInOut, Resampler};

/// Resampler audio utilisant rubato (FFT-based, haute qualité)
pub struct AudioResampler {
    resampler: FftFixedInOut<f32>,
    channels: usize,
    /// Buffer d'entrée désentrelacé (un Vec par canal)
    input_buffers: Vec<Vec<f32>>,
    /// Buffer de sortie désentrelacé
    output_buffers: Vec<Vec<f32>>,
    /// Taille de chunk d'entrée requise par rubato
    chunk_size_in: usize,
    /// Buffer d'accumulation pour les samples en attente
    pending_samples: Vec<f32>,
    /// Ratio de resampling (source_rate / target_rate)
    resample_ratio: f64,
}

impl AudioResampler {
    /// Crée un nouveau resampler
    ///
    /// # Arguments
    /// * `source_rate` - Sample rate du fichier source (ex: 192000)
    /// * `target_rate` - Sample rate cible du DAC (ex: 96000)
    /// * `channels` - Nombre de canaux (2 pour stéréo)
    pub fn new(source_rate: u32, target_rate: u32, channels: usize) -> Result<Self, String> {
        // Taille de chunk - rubato fonctionne par blocs
        // 1024 samples est un bon compromis latence/efficacité
        let chunk_size = 1024;

        let resampler = FftFixedInOut::<f32>::new(
            source_rate as usize,
            target_rate as usize,
            chunk_size,
            2,  // sub_chunks pour meilleure qualité
        ).map_err(|e| format!("Failed to create resampler: {}", e))?;

        let chunk_size_in = resampler.input_frames_max();
        let chunk_size_out = resampler.output_frames_max();

        // Pré-alloue les buffers
        let input_buffers = vec![vec![0.0f32; chunk_size_in]; channels];
        let output_buffers = vec![vec![0.0f32; chunk_size_out]; channels];

        let resample_ratio = source_rate as f64 / target_rate as f64;

        #[cfg(debug_assertions)]
        println!(
            "=== Resampler created ===\n  {} Hz → {} Hz (ratio: {:.4})\n  channels: {}\n  chunk_size_in: {}\n  chunk_size_out: {}",
            source_rate, target_rate, resample_ratio, channels, chunk_size_in, chunk_size_out
        );

        Ok(Self {
            resampler,
            channels,
            input_buffers,
            output_buffers,
            chunk_size_in,
            pending_samples: Vec::with_capacity(chunk_size_in * channels * 2),
            resample_ratio,
        })
    }

    /// Traite des samples entrelacés et retourne des samples resampleés
    ///
    /// L'entrée est en format entrelacé : [L0, R0, L1, R1, L2, R2, ...]
    /// La sortie est aussi entrelacée au nouveau sample rate
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        // Ajoute les nouveaux samples au buffer en attente
        self.pending_samples.extend_from_slice(input);

        let samples_per_chunk = self.chunk_size_in * self.channels;
        let mut output = Vec::new();

        // Traite tous les chunks complets disponibles
        while self.pending_samples.len() >= samples_per_chunk {
            // Désentrelace un chunk vers input_buffers
            self.deinterleave_chunk();

            // Resample
            match self.resampler.process(&self.input_buffers, None) {
                Ok(resampled) => {
                    // Entrelace la sortie
                    let frames_out = resampled[0].len();
                    output.reserve(frames_out * self.channels);

                    for frame in 0..frames_out {
                        for ch in 0..self.channels {
                            output.push(resampled[ch][frame]);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Resampler error: {}", e);
                    // En cas d'erreur, retourne les samples originaux (dégradé mais pas de silence)
                    break;
                }
            }

            // Retire le chunk traité du buffer pending
            self.pending_samples.drain(..samples_per_chunk);
        }

        output
    }

    /// Finalise le resampling en vidant le buffer pending
    /// Appelé en fin de fichier pour traiter les samples restants
    pub fn flush(&mut self) -> Vec<f32> {
        if self.pending_samples.is_empty() {
            return Vec::new();
        }

        let samples_per_chunk = self.chunk_size_in * self.channels;

        // Padding avec des zéros pour compléter le dernier chunk
        while self.pending_samples.len() < samples_per_chunk {
            self.pending_samples.push(0.0);
        }

        // Traite le dernier chunk
        self.process(&[])
    }

    /// Désentrelace un chunk de pending_samples vers input_buffers
    fn deinterleave_chunk(&mut self) {
        for frame in 0..self.chunk_size_in {
            for ch in 0..self.channels {
                let idx = frame * self.channels + ch;
                self.input_buffers[ch][frame] = self.pending_samples[idx];
            }
        }
    }

    /// Retourne le ratio de resampling
    pub fn ratio(&self) -> f64 {
        self.resample_ratio
    }

    /// Retourne true si c'est un downsampling (ex: 192kHz → 96kHz)
    pub fn is_downsampling(&self) -> bool {
        self.resample_ratio > 1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resampler_creation() {
        let resampler = AudioResampler::new(96000, 48000, 2);
        assert!(resampler.is_ok());

        let r = resampler.unwrap();
        assert_eq!(r.ratio(), 2.0);
        assert!(r.is_downsampling());
    }

    #[test]
    fn test_resampler_44100_to_48000() {
        let resampler = AudioResampler::new(44100, 48000, 2);
        assert!(resampler.is_ok());

        let r = resampler.unwrap();
        assert!(!r.is_downsampling()); // Upsampling
    }
}
