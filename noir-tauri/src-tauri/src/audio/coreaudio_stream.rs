//! CoreAudio AudioUnit-based output stream for macOS
//!
//! This implementation uses coreaudio-sys for direct AudioUnit control,
//! which allows us to call AudioUnitReset() for instant seek.
//!
//! Key difference from CPAL: we have direct access to the AudioUnit pointer,
//! so we can flush its internal buffer during seek.
//!
//! PURE COREAUDIO - No CPAL dependency!
//! Uses kAudioUnitSubType_HALOutput to allow device selection.

use std::ffi::c_void;
use std::mem;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use parking_lot::Mutex;

use coreaudio_sys::{
    AudioComponentDescription, AudioComponentFindNext, AudioComponentInstanceNew,
    AudioComponentInstanceDispose, AudioOutputUnitStart, AudioOutputUnitStop,
    AudioUnitInitialize, AudioUnitReset, AudioUnitSetProperty, AudioUnitUninitialize,
    AudioUnit as SysAudioUnit, AudioStreamBasicDescription, AudioObjectID,
    kAudioFormatFlagsNativeFloatPacked, kAudioFormatLinearPCM,
    kAudioUnitProperty_SetRenderCallback, kAudioUnitProperty_StreamFormat,
    kAudioUnitScope_Global, kAudioUnitScope_Input, kAudioUnitType_Output,
    kAudioUnitSubType_HALOutput, kAudioUnitManufacturer_Apple,
    kAudioOutputUnitProperty_CurrentDevice,
    AURenderCallbackStruct, AudioUnitRenderActionFlags, AudioTimeStamp,
    AudioBufferList,
};
use ringbuf::HeapCons;
use ringbuf::traits::Consumer;
use tauri::{AppHandle, Emitter};

use crate::audio_decoder::StreamingState;
use crate::audio_engine::PlaybackProgress;
use crate::eq::{EqProcessor, EqSharedState};
use super::stream::{AudioOutputStream, AudioStreamConfig};

/// CoreAudio-based audio output stream using raw coreaudio-sys
pub struct CoreAudioStream {
    audio_unit: SysAudioUnit,
    config: AudioStreamConfig,
    is_playing: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    // Box to prevent the callback data from being dropped
    _callback_data: Box<CallbackData>,
}

/// Data passed to the render callback
struct CallbackData {
    consumer: HeapCons<f32>,
    streaming_state: Arc<StreamingState>,
    volume_atomic: Arc<AtomicU64>,
    position_state: Arc<AtomicU64>,
    is_playing_global: Arc<AtomicBool>,
    is_playing_local: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    app_handle: Option<AppHandle>,
    duration_seconds: f64,
    channels_count: u64,
    sample_rate_f64: f64,
    duration_samples: u64,
    emit_interval: u32,
    stream_id: u64,
    // Mutable state
    playback_samples: u64,
    emit_counter: u32,
    end_emitted: bool,
    empty_callbacks: u32,
    first_read_after_seek: bool,
    debug_seek_target: f64,
    debug_sample_log_countdown: u32,
    progress_ticks_after_seek: u32,
    debug_last_seek_target: f64,
    // EQ processing (biquad filters - NOT thread-safe, lives in callback)
    eq_processor: EqProcessor,
    eq_shared: EqSharedState,
    // Gapless playback: next track preloaded consumer/state
    next_consumer: Arc<Mutex<Option<HeapCons<f32>>>>,
    next_streaming_state: Arc<Mutex<Option<Arc<StreamingState>>>>,
    gapless_enabled: Arc<AtomicBool>,
    // RMS energy for visualisation (shared with frontend via AtomicU64 as f64 bits)
    rms_energy: Arc<AtomicU64>,
}

const EMPTY_CALLBACKS_THRESHOLD: u32 = 3;

impl CoreAudioStream {
    /// Create a new CoreAudio stream
    ///
    /// # Arguments
    /// * `device_id` - Optional CoreAudio device ID. If None, uses system default.
    /// * `config` - Stream configuration (sample rate, channels)
    /// * Other args for streaming state
    pub fn new(
        device_id: Option<AudioObjectID>,
        config: AudioStreamConfig,
        consumer: HeapCons<f32>,
        streaming_state: Arc<StreamingState>,
        volume_atomic: Arc<AtomicU64>,
        position_state: Arc<AtomicU64>,
        is_playing_global: Arc<AtomicBool>,
        app_handle: Option<AppHandle>,
        duration_seconds: f64,
        eq_shared: EqSharedState,
        next_consumer: Arc<Mutex<Option<HeapCons<f32>>>>,
        next_streaming_state: Arc<Mutex<Option<Arc<StreamingState>>>>,
        gapless_enabled: Arc<AtomicBool>,
        rms_energy: Arc<AtomicU64>,
    ) -> Result<Self, String> {
        unsafe {
            // 1. Find the HAL output audio component (allows device selection)
            // Note: We use HALOutput instead of DefaultOutput to be able to select a specific device
            let desc = AudioComponentDescription {
                componentType: kAudioUnitType_Output,
                componentSubType: kAudioUnitSubType_HALOutput,
                componentManufacturer: kAudioUnitManufacturer_Apple,
                componentFlags: 0,
                componentFlagsMask: 0,
            };

            let component = AudioComponentFindNext(ptr::null_mut(), &desc);
            if component.is_null() {
                return Err("Failed to find HAL audio output component".to_string());
            }

            // 2. Create an instance of the audio unit
            let mut audio_unit: SysAudioUnit = ptr::null_mut();
            let status = AudioComponentInstanceNew(component, &mut audio_unit);
            if status != 0 {
                return Err(format!("AudioComponentInstanceNew failed: {}", status));
            }

            // 2b. Set the output device if specified
            if let Some(dev_id) = device_id {
                println!("[CoreAudioStream] Setting output device to ID: {}", dev_id);
                let status = AudioUnitSetProperty(
                    audio_unit,
                    kAudioOutputUnitProperty_CurrentDevice,
                    kAudioUnitScope_Global,
                    0,
                    &dev_id as *const _ as *const c_void,
                    mem::size_of::<AudioObjectID>() as u32,
                );
                if status != 0 {
                    println!("[CoreAudioStream] WARNING: Failed to set device {}: error {}", dev_id, status);
                    // Don't fail - fall back to default device
                } else {
                    println!("[CoreAudioStream] Output device set successfully");
                }
            } else {
                println!("[CoreAudioStream] Using system default output device");
            }

            // 3. Set the stream format
            let asbd = AudioStreamBasicDescription {
                mSampleRate: config.sample_rate as f64,
                mFormatID: kAudioFormatLinearPCM,
                mFormatFlags: kAudioFormatFlagsNativeFloatPacked,
                mBytesPerPacket: 4 * config.channels as u32,
                mFramesPerPacket: 1,
                mBytesPerFrame: 4 * config.channels as u32,
                mChannelsPerFrame: config.channels as u32,
                mBitsPerChannel: 32,
                mReserved: 0,
            };

            let status = AudioUnitSetProperty(
                audio_unit,
                kAudioUnitProperty_StreamFormat,
                kAudioUnitScope_Input,
                0, // Element 0 = output
                &asbd as *const _ as *const c_void,
                mem::size_of::<AudioStreamBasicDescription>() as u32,
            );
            if status != 0 {
                AudioComponentInstanceDispose(audio_unit);
                return Err(format!("Failed to set stream format: {}", status));
            }

            println!("[CoreAudioStream] Configured: {}Hz, {} channels",
                config.sample_rate, config.channels);

            // 4. Prepare shared state
            let is_playing = Arc::new(AtomicBool::new(false));
            let is_paused = Arc::new(AtomicBool::new(false));

            // Stream ID for debugging
            static STREAM_COUNTER: AtomicU64 = AtomicU64::new(0);
            let stream_id = STREAM_COUNTER.fetch_add(1, Ordering::Relaxed);
            println!("[CoreAudioStream] Created stream_id={}", stream_id);

            // 5. Create callback data
            let channels_count = config.channels as u64;
            let sample_rate_f64 = config.sample_rate as f64;
            let duration_samples = streaming_state.info.total_frames * channels_count;
            let emit_interval = config.sample_rate / 30;

            let callback_data = Box::new(CallbackData {
                consumer,
                streaming_state: Arc::clone(&streaming_state),
                volume_atomic: Arc::clone(&volume_atomic),
                position_state: Arc::clone(&position_state),
                is_playing_global: Arc::clone(&is_playing_global),
                is_playing_local: Arc::clone(&is_playing),
                is_paused: Arc::clone(&is_paused),
                app_handle,
                duration_seconds,
                channels_count,
                sample_rate_f64,
                duration_samples,
                emit_interval,
                stream_id,
                playback_samples: streaming_state.playback_position.load(Ordering::Relaxed),
                emit_counter: 0,
                end_emitted: false,
                empty_callbacks: 0,
                first_read_after_seek: false,
                debug_seek_target: 0.0,
                debug_sample_log_countdown: 0,
                progress_ticks_after_seek: 0,
                debug_last_seek_target: 0.0,
                eq_processor: EqProcessor::new(sample_rate_f64 as f32),
                eq_shared,
                next_consumer,
                next_streaming_state,
                gapless_enabled,
                rms_energy,
            });

            // 6. Set up the render callback
            let callback_struct = AURenderCallbackStruct {
                inputProc: Some(render_callback),
                inputProcRefCon: &*callback_data as *const CallbackData as *mut c_void,
            };

            let status = AudioUnitSetProperty(
                audio_unit,
                kAudioUnitProperty_SetRenderCallback,
                kAudioUnitScope_Input,
                0,
                &callback_struct as *const _ as *const c_void,
                mem::size_of::<AURenderCallbackStruct>() as u32,
            );
            if status != 0 {
                AudioComponentInstanceDispose(audio_unit);
                return Err(format!("Failed to set render callback: {}", status));
            }

            // 7. Initialize the audio unit
            let status = AudioUnitInitialize(audio_unit);
            if status != 0 {
                AudioComponentInstanceDispose(audio_unit);
                return Err(format!("AudioUnitInitialize failed: {}", status));
            }

            Ok(Self {
                audio_unit,
                config,
                is_playing,
                is_paused,
                _callback_data: callback_data,
            })
        }
    }
}

/// The render callback function called by CoreAudio
unsafe extern "C" fn render_callback(
    in_ref_con: *mut c_void,
    _io_action_flags: *mut AudioUnitRenderActionFlags,
    _in_time_stamp: *const AudioTimeStamp,
    _in_bus_number: u32,
    in_number_frames: u32,
    io_data: *mut AudioBufferList,
) -> i32 {
    let data = &mut *(in_ref_con as *mut CallbackData);

    // Get the audio buffer
    let buffer_list = &mut *io_data;
    let num_buffers = buffer_list.mNumberBuffers as usize;

    // Get volume
    let volume = f32::from_bits(data.volume_atomic.load(Ordering::Relaxed) as u32);

    // Check if we're paused or not playing
    if data.is_paused.load(Ordering::Relaxed) || !data.is_playing_local.load(Ordering::Relaxed) {
        // Output silence
        for i in 0..num_buffers {
            let buffer = &mut *buffer_list.mBuffers.as_mut_ptr().add(i);
            let samples = std::slice::from_raw_parts_mut(
                buffer.mData as *mut f32,
                buffer.mDataByteSize as usize / 4,
            );
            for sample in samples.iter_mut() {
                *sample = 0.0;
            }
        }
        return 0;
    }

    // If track ended, output silence
    if data.end_emitted {
        for i in 0..num_buffers {
            let buffer = &mut *buffer_list.mBuffers.as_mut_ptr().add(i);
            let samples = std::slice::from_raw_parts_mut(
                buffer.mData as *mut f32,
                buffer.mDataByteSize as usize / 4,
            );
            for sample in samples.iter_mut() {
                *sample = 0.0;
            }
        }
        return 0;
    }

    // Check if buffer needs to be flushed (after seek)
    if data.streaming_state.flush_buffer.load(Ordering::Acquire) {
        println!("[CoreAudioStream] Flush executing on stream_id={}", data.stream_id);

        // Prepare debug logging
        let seek_pos = data.streaming_state.seek_position.load(Ordering::Relaxed);
        data.debug_seek_target = seek_pos as f64 / data.channels_count as f64 / data.sample_rate_f64;
        data.first_read_after_seek = true;
        data.debug_last_seek_target = data.debug_seek_target;
        data.progress_ticks_after_seek = 0;
        data.debug_sample_log_countdown = 3;

        // Flush the RingBuffer
        let mut flush_buf = [0.0f32; 4096];
        let mut total_flushed = 0usize;
        loop {
            let flushed = data.consumer.pop_slice(&mut flush_buf);
            if flushed == 0 {
                break;
            }
            total_flushed += flushed;
        }
        println!("[CoreAudioStream] RingBuffer flushed: {} samples", total_flushed);

        // Clear flush flag and signal completion
        data.streaming_state.flush_buffer.store(false, Ordering::Release);
        data.streaming_state.flush_complete.store(true, Ordering::Release);

        // Update position to seek target
        data.playback_samples = data.streaming_state.seek_position.load(Ordering::Relaxed);
        data.empty_callbacks = 0;

        // Output silence for this callback
        for i in 0..num_buffers {
            let buffer = &mut *buffer_list.mBuffers.as_mut_ptr().add(i);
            let samples = std::slice::from_raw_parts_mut(
                buffer.mData as *mut f32,
                buffer.mDataByteSize as usize / 4,
            );
            for sample in samples.iter_mut() {
                *sample = 0.0;
            }
        }
        return 0;
    }

    // Check if seek is in progress (pre-fill not complete)
    if data.streaming_state.seeking.load(Ordering::Acquire) {
        for i in 0..num_buffers {
            let buffer = &mut *buffer_list.mBuffers.as_mut_ptr().add(i);
            let samples = std::slice::from_raw_parts_mut(
                buffer.mData as *mut f32,
                buffer.mDataByteSize as usize / 4,
            );
            for sample in samples.iter_mut() {
                *sample = 0.0;
            }
        }
        data.playback_samples = data.streaming_state.seek_position.load(Ordering::Relaxed);
        data.empty_callbacks = 0;
        return 0;
    }

    // For interleaved stereo output, we have one buffer with interleaved samples
    // Read from RingBuffer (which has interleaved samples)
    let total_samples = in_number_frames as usize * data.channels_count as usize;
    let mut interleaved_buf = vec![0.0f32; total_samples];
    let read = data.consumer.pop_slice(&mut interleaved_buf);

    // Debug logging after seek
    if data.first_read_after_seek && read > 0 {
        let current_pos_time = data.playback_samples as f64 / data.channels_count as f64 / data.sample_rate_f64;
        println!("[CoreAudioStream] First read after seek: samples={}, pos={:.3}s, expected={:.3}s, read={}",
            data.playback_samples, current_pos_time, data.debug_seek_target, read);
        data.first_read_after_seek = false;
    }

    if data.debug_sample_log_countdown > 0 && read >= 8 {
        println!("[CoreAudioStream] Callback #{}: [{:.6}, {:.6}, {:.6}, {:.6}]",
            4 - data.debug_sample_log_countdown,
            interleaved_buf[0], interleaved_buf[1], interleaved_buf[2], interleaved_buf[3]);
        data.debug_sample_log_countdown -= 1;
    }

    // Apply EQ processing BEFORE volume (operates on the raw signal)
    if read > 0 {
        let frames_for_eq = read / data.channels_count as usize;
        data.eq_processor.process_interleaved(
            &mut interleaved_buf[..read],
            frames_for_eq,
            &data.eq_shared,
        );
    }

    // Compute RMS energy for visualisation (lightweight — just sum of squares)
    if read > 0 {
        let mut sum_sq: f64 = 0.0;
        for i in 0..read {
            let s = interleaved_buf[i] as f64;
            sum_sq += s * s;
        }
        let rms = (sum_sq / read as f64).sqrt();
        data.rms_energy.store(rms.to_bits(), Ordering::Relaxed);
    }

    // Write to output buffers with volume applied
    // CoreAudio on macOS typically uses interleaved stereo in a single buffer
    if num_buffers == 1 && data.channels_count == 2 {
        // Single interleaved buffer
        let buffer = &mut *buffer_list.mBuffers.as_mut_ptr();
        let out_samples = std::slice::from_raw_parts_mut(
            buffer.mData as *mut f32,
            buffer.mDataByteSize as usize / 4,
        );

        if volume < 1.0 {
            for (i, sample) in interleaved_buf[..read].iter().enumerate() {
                if i < out_samples.len() {
                    out_samples[i] = sample * volume;
                }
            }
        } else {
            // Bit-perfect bypass: copy samples without modification
            let copy_len = read.min(out_samples.len());
            out_samples[..copy_len].copy_from_slice(&interleaved_buf[..copy_len]);
        }
        // Fill remaining with silence
        for sample in out_samples[read..].iter_mut() {
            *sample = 0.0;
        }
    } else {
        // Non-interleaved (separate buffers per channel)
        let frames_read = read / data.channels_count as usize;
        for ch in 0..num_buffers.min(data.channels_count as usize) {
            let buffer = &mut *buffer_list.mBuffers.as_mut_ptr().add(ch);
            let out_samples = std::slice::from_raw_parts_mut(
                buffer.mData as *mut f32,
                buffer.mDataByteSize as usize / 4,
            );

            for frame in 0..in_number_frames as usize {
                let idx = frame * data.channels_count as usize + ch;
                if frame < frames_read && idx < read {
                    out_samples[frame] = if volume < 1.0 { interleaved_buf[idx] * volume } else { interleaved_buf[idx] };
                } else {
                    out_samples[frame] = 0.0;
                }
            }
        }
    }

    // Update playback position
    if read > 0 {
        data.playback_samples += read as u64;
        if data.playback_samples > data.duration_samples {
            data.playback_samples = data.duration_samples;
        }
        data.empty_callbacks = 0;
    } else {
        data.empty_callbacks += 1;
    }

    // Detect end of track
    if data.streaming_state.decoding_complete.load(Ordering::Relaxed)
        && data.empty_callbacks >= EMPTY_CALLBACKS_THRESHOLD
        && !data.end_emitted
    {
        // === GAPLESS: try to swap to next consumer ===
        if data.gapless_enabled.load(Ordering::Relaxed) {
            let mut next_cons_guard = data.next_consumer.lock();
            let mut next_state_guard = data.next_streaming_state.lock();

            if let (Some(new_consumer), Some(new_state)) = (next_cons_guard.take(), next_state_guard.take()) {
                println!("[CoreAudioStream] GAPLESS TRANSITION at {:.3}s",
                    data.playback_samples as f64 / data.channels_count as f64 / data.sample_rate_f64);

                // Swap consumer and streaming state
                data.consumer = new_consumer;
                data.streaming_state = new_state;

                // Reset playback tracking for the new track
                data.playback_samples = 0;
                data.empty_callbacks = 0;
                data.end_emitted = false;
                data.emit_counter = 0;
                data.duration_seconds = data.streaming_state.info.duration_seconds;
                data.duration_samples = data.streaming_state.info.total_frames * data.channels_count;

                // Emit gapless transition event to frontend
                if let Some(ref app) = data.app_handle {
                    let _ = app.emit("playback_gapless_transition", ());
                }

                // Drop the guards
                drop(next_cons_guard);
                drop(next_state_guard);

                // Don't return 0 — continue to output from new consumer in THIS callback
                // The next emit cycle will send progress from the new track
                return 0;
            }
        }

        // No gapless next available — normal end
        data.end_emitted = true;
        data.is_playing_global.store(false, Ordering::Relaxed);
        println!("[CoreAudioStream] Track finished at {:.3}s",
            data.playback_samples as f64 / data.channels_count as f64 / data.sample_rate_f64);
        if let Some(ref app) = data.app_handle {
            let _ = app.emit("playback_ended", ());
        }
    }

    // Emit progress (~30 FPS)
    data.emit_counter += in_number_frames;
    if data.emit_counter >= data.emit_interval {
        data.emit_counter = 0;

        let position_seconds = data.playback_samples as f64 / data.channels_count as f64 / data.sample_rate_f64;
        let clamped_position = position_seconds.min(data.duration_seconds * 0.999);
        let position_ms = (clamped_position * 1000.0) as u64;
        data.position_state.store(position_ms, Ordering::Relaxed);

        if data.progress_ticks_after_seek < 5 {
            data.progress_ticks_after_seek += 1;
            println!("[CoreAudioStream] Progress #{} after seek: {:.3}s (target was {:.3}s)",
                data.progress_ticks_after_seek, clamped_position, data.debug_last_seek_target);
        }

        if let Some(ref app) = data.app_handle {
            let rms = f64::from_bits(data.rms_energy.load(Ordering::Relaxed));
            let _ = app.emit("playback_progress", PlaybackProgress {
                position: clamped_position,
                duration: data.duration_seconds,
                rms,
            });
        }
    }

    0 // Return noErr
}

impl AudioOutputStream for CoreAudioStream {
    fn start(&mut self) -> Result<(), String> {
        unsafe {
            let status = AudioOutputUnitStart(self.audio_unit);
            if status != 0 {
                return Err(format!("AudioOutputUnitStart failed: {}", status));
            }
        }
        self.is_playing.store(true, Ordering::Relaxed);
        self.is_paused.store(false, Ordering::Relaxed);
        println!("[CoreAudioStream] Started");
        Ok(())
    }

    fn pause(&mut self) -> Result<(), String> {
        self.is_paused.store(true, Ordering::Relaxed);
        println!("[CoreAudioStream] Paused");
        Ok(())
    }

    fn resume(&mut self) -> Result<(), String> {
        self.is_paused.store(false, Ordering::Relaxed);
        println!("[CoreAudioStream] Resumed");
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        self.is_playing.store(false, Ordering::Relaxed);
        unsafe {
            let status = AudioOutputUnitStop(self.audio_unit);
            if status != 0 {
                return Err(format!("AudioOutputUnitStop failed: {}", status));
            }
        }
        println!("[CoreAudioStream] Stopped");
        Ok(())
    }

    fn reset(&mut self) -> Result<(), String> {
        // THIS IS THE KEY FOR INSTANT SEEK!
        // AudioUnitReset flushes CoreAudio's internal buffers (~50ms worth)
        println!("[CoreAudioStream] Resetting AudioUnit (flushing internal buffers)...");

        unsafe {
            let status = AudioUnitReset(
                self.audio_unit,
                kAudioUnitScope_Global,
                0,
            );
            if status != 0 {
                return Err(format!("AudioUnitReset failed: {}", status));
            }
        }

        println!("[CoreAudioStream] AudioUnit reset complete - buffers flushed");
        Ok(())
    }

    fn is_playing(&self) -> bool {
        self.is_playing.load(Ordering::Relaxed) && !self.is_paused.load(Ordering::Relaxed)
    }

    fn sample_rate(&self) -> u32 {
        self.config.sample_rate
    }

    fn channels(&self) -> u16 {
        self.config.channels
    }
}

impl Drop for CoreAudioStream {
    fn drop(&mut self) {
        unsafe {
            let _ = AudioOutputUnitStop(self.audio_unit);
            let _ = AudioUnitUninitialize(self.audio_unit);
            let _ = AudioComponentInstanceDispose(self.audio_unit);
        }
        println!("[CoreAudioStream] Dropped");
    }
}

// Safety: The audio unit and callback data are properly synchronized
unsafe impl Send for CoreAudioStream {}
