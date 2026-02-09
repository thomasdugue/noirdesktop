//! CoreAudio HAL backend for macOS
//!
//! Uses coreaudio-sys for direct HAL access to:
//! - Enumerate audio devices
//! - Change hardware sample rate (kAudioDevicePropertyNominalSampleRate)
//! - Enable Hog Mode (kAudioDevicePropertyHogMode) for exclusive access
//! - Listen for device changes
//!
//! This file is only compiled on macOS via #[cfg(target_os = "macos")]

use std::collections::HashMap;
use std::ffi::c_void;
use std::time::Duration;

use core_foundation::base::TCFType;
use core_foundation::string::{CFString, CFStringRef};
use coreaudio_sys::*;
use cpal::traits::{DeviceTrait, HostTrait};

use crate::audio::backend::AudioBackend;
use crate::audio::error::{AudioBackendError, Result};
use crate::audio::types::*;

/// CoreAudio HAL backend
///
/// IMPORTANT: This backend follows the system default output device.
/// When the user plugs in headphones or a DAC, we automatically switch to it.
pub struct CoreAudioBackend {
    /// Manually selected device ID (None = follow system default)
    /// When None, we always query the current default device
    manual_device_id: Option<AudioObjectID>,
    /// Cached device info map (device_id -> DeviceInfo)
    device_cache: HashMap<String, DeviceInfo>,
    /// Current exclusive mode state
    exclusive_mode: ExclusiveMode,
    /// Original sample rate (to restore on release) - keyed by device ID
    original_sample_rates: HashMap<AudioObjectID, u32>,
    /// Device event callback
    event_callback: Option<DeviceEventCallback>,
    /// Last known device ID (to detect changes)
    last_device_id: AudioObjectID,
}

impl CoreAudioBackend {
    /// Create a new CoreAudio backend
    pub fn new() -> Result<Self> {
        println!("[CoreAudio] Initializing backend...");

        let default_device = Self::get_default_output_device()?;

        let mut backend = Self {
            manual_device_id: None, // Follow system default
            device_cache: HashMap::new(),
            exclusive_mode: ExclusiveMode::Shared,
            original_sample_rates: HashMap::new(),
            event_callback: None,
            last_device_id: default_device,
        };

        // Cache device info on startup
        backend.refresh_device_cache()?;

        let device_name = backend
            .device_cache
            .get(&default_device.to_string())
            .map(|d| d.name.clone())
            .unwrap_or_else(|| "Unknown".to_string());

        println!(
            "[CoreAudio] Backend initialized. Default device: {} (ID: {})",
            device_name, default_device
        );

        Ok(backend)
    }

    /// Get the current active device ID
    /// If manual_device_id is set, use that. Otherwise, follow system default.
    fn get_active_device_id(&self) -> Result<AudioObjectID> {
        match self.manual_device_id {
            Some(id) => Ok(id),
            None => Self::get_default_output_device(),
        }
    }

    /// Check if device has changed since last check
    fn check_device_change(&mut self) -> Option<AudioObjectID> {
        if let Ok(current_id) = self.get_active_device_id() {
            if current_id != self.last_device_id {
                let old_id = self.last_device_id;
                self.last_device_id = current_id;

                // Refresh cache to include new device
                let _ = self.refresh_device_cache();

                let old_name = self.device_cache
                    .get(&old_id.to_string())
                    .map(|d| d.name.clone())
                    .unwrap_or_else(|| old_id.to_string());
                let new_name = self.device_cache
                    .get(&current_id.to_string())
                    .map(|d| d.name.clone())
                    .unwrap_or_else(|| current_id.to_string());

                println!(
                    "[CoreAudio] Device changed: {} -> {}",
                    old_name, new_name
                );

                return Some(current_id);
            }
        }
        None
    }

    // === Private HAL Functions ===

    /// Get the system default output device
    fn get_default_output_device() -> Result<AudioObjectID> {
        unsafe {
            let property_address = AudioObjectPropertyAddress {
                mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            };

            let mut device_id: AudioObjectID = kAudioObjectUnknown;
            let mut size = std::mem::size_of::<AudioObjectID>() as u32;

            let status = AudioObjectGetPropertyData(
                kAudioObjectSystemObject,
                &property_address,
                0,
                std::ptr::null(),
                &mut size,
                &mut device_id as *mut _ as *mut c_void,
            );

            if status != 0 || device_id == kAudioObjectUnknown {
                return Err(AudioBackendError::DeviceNotFound(
                    "No default output device".to_string(),
                ));
            }

            Ok(device_id)
        }
    }

    /// Get all output devices
    fn get_all_output_devices() -> Result<Vec<AudioObjectID>> {
        unsafe {
            let property_address = AudioObjectPropertyAddress {
                mSelector: kAudioHardwarePropertyDevices,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            };

            // Get the size first
            let mut size: u32 = 0;
            let status = AudioObjectGetPropertyDataSize(
                kAudioObjectSystemObject,
                &property_address,
                0,
                std::ptr::null(),
                &mut size,
            );

            if status != 0 {
                return Err(AudioBackendError::DeviceEnumerationFailed(format!(
                    "Failed to get device list size: {}",
                    status
                )));
            }

            let device_count = size as usize / std::mem::size_of::<AudioObjectID>();
            let mut devices: Vec<AudioObjectID> = vec![0; device_count];

            let status = AudioObjectGetPropertyData(
                kAudioObjectSystemObject,
                &property_address,
                0,
                std::ptr::null(),
                &mut size,
                devices.as_mut_ptr() as *mut c_void,
            );

            if status != 0 {
                return Err(AudioBackendError::DeviceEnumerationFailed(format!(
                    "Failed to get device list: {}",
                    status
                )));
            }

            // Filter to output devices only
            let output_devices: Vec<AudioObjectID> = devices
                .into_iter()
                .filter(|&id| Self::device_has_output_streams(id))
                .collect();

            Ok(output_devices)
        }
    }

    /// Check if a device has output streams
    fn device_has_output_streams(device_id: AudioObjectID) -> bool {
        unsafe {
            let property_address = AudioObjectPropertyAddress {
                mSelector: kAudioDevicePropertyStreamConfiguration,
                mScope: kAudioDevicePropertyScopeOutput,
                mElement: kAudioObjectPropertyElementMain,
            };

            let mut size: u32 = 0;
            let status = AudioObjectGetPropertyDataSize(
                device_id,
                &property_address,
                0,
                std::ptr::null(),
                &mut size,
            );

            if status != 0 || size == 0 {
                return false;
            }

            // Allocate buffer for AudioBufferList
            let mut buffer = vec![0u8; size as usize];
            let buffer_list = buffer.as_mut_ptr() as *mut AudioBufferList;

            let status = AudioObjectGetPropertyData(
                device_id,
                &property_address,
                0,
                std::ptr::null(),
                &mut size,
                buffer_list as *mut c_void,
            );

            if status != 0 {
                return false;
            }

            (*buffer_list).mNumberBuffers > 0
        }
    }

    /// Get device name
    fn get_device_name(device_id: AudioObjectID) -> Result<String> {
        unsafe {
            let property_address = AudioObjectPropertyAddress {
                mSelector: kAudioObjectPropertyName,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            };

            let mut cf_name: CFStringRef = std::ptr::null();
            let mut size = std::mem::size_of::<CFStringRef>() as u32;

            let status = AudioObjectGetPropertyData(
                device_id,
                &property_address,
                0,
                std::ptr::null(),
                &mut size,
                &mut cf_name as *mut _ as *mut c_void,
            );

            if status != 0 || cf_name.is_null() {
                return Err(AudioBackendError::Other(format!(
                    "Failed to get device name: {}",
                    status
                )));
            }

            // Convert CFString to Rust String
            let cf_string: CFString = CFString::wrap_under_get_rule(cf_name);
            Ok(cf_string.to_string())
        }
    }

    /// Get current sample rate of a device
    fn get_device_sample_rate(device_id: AudioObjectID) -> Result<u32> {
        unsafe {
            let property_address = AudioObjectPropertyAddress {
                mSelector: kAudioDevicePropertyNominalSampleRate,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            };

            let mut sample_rate: f64 = 0.0;
            let mut size = std::mem::size_of::<f64>() as u32;

            let status = AudioObjectGetPropertyData(
                device_id,
                &property_address,
                0,
                std::ptr::null(),
                &mut size,
                &mut sample_rate as *mut _ as *mut c_void,
            );

            if status != 0 {
                return Err(AudioBackendError::Other(format!(
                    "Failed to get sample rate: {}",
                    status
                )));
            }

            Ok(sample_rate as u32)
        }
    }

    /// Set sample rate of a device
    fn set_device_sample_rate_internal(device_id: AudioObjectID, rate: u32) -> Result<()> {
        println!(
            "[CoreAudio] Setting device {} sample rate to {} Hz...",
            device_id, rate
        );

        unsafe {
            let property_address = AudioObjectPropertyAddress {
                mSelector: kAudioDevicePropertyNominalSampleRate,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            };

            let sample_rate: f64 = rate as f64;

            let status = AudioObjectSetPropertyData(
                device_id,
                &property_address,
                0,
                std::ptr::null(),
                std::mem::size_of::<f64>() as u32,
                &sample_rate as *const _ as *const c_void,
            );

            if status != 0 {
                return Err(AudioBackendError::SampleRateChangeFailed {
                    requested: rate,
                    reason: format!("CoreAudio error code: {}", status),
                });
            }

            // Wait for the hardware to confirm the change
            std::thread::sleep(Duration::from_millis(100));

            // Verify the change took effect
            let actual_rate = Self::get_device_sample_rate(device_id)?;

            if actual_rate != rate {
                println!(
                    "[CoreAudio] Warning: Requested {} Hz but device reports {} Hz",
                    rate, actual_rate
                );
                return Err(AudioBackendError::SampleRateChangeFailed {
                    requested: rate,
                    reason: format!("Device set to {} Hz instead of {} Hz", actual_rate, rate),
                });
            }

            println!("[CoreAudio] Sample rate successfully set to {} Hz", rate);
            Ok(())
        }
    }

    /// Get supported sample rates for a device
    fn get_supported_sample_rates(device_id: AudioObjectID) -> Result<Vec<u32>> {
        unsafe {
            let property_address = AudioObjectPropertyAddress {
                mSelector: kAudioDevicePropertyAvailableNominalSampleRates,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            };

            let mut size: u32 = 0;
            let status = AudioObjectGetPropertyDataSize(
                device_id,
                &property_address,
                0,
                std::ptr::null(),
                &mut size,
            );

            if status != 0 {
                return Err(AudioBackendError::Other(format!(
                    "Failed to get sample rate range size: {}",
                    status
                )));
            }

            let count = size as usize / std::mem::size_of::<AudioValueRange>();
            let mut ranges: Vec<AudioValueRange> = vec![
                AudioValueRange {
                    mMinimum: 0.0,
                    mMaximum: 0.0,
                };
                count
            ];

            let status = AudioObjectGetPropertyData(
                device_id,
                &property_address,
                0,
                std::ptr::null(),
                &mut size,
                ranges.as_mut_ptr() as *mut c_void,
            );

            if status != 0 {
                return Err(AudioBackendError::Other(format!(
                    "Failed to get sample rate ranges: {}",
                    status
                )));
            }

            // Extract supported standard rates from the ranges
            let mut rates = Vec::new();
            for &standard_rate in SampleRate::STANDARD_RATES.iter() {
                let rate_f64 = standard_rate as f64;
                for range in &ranges {
                    if rate_f64 >= range.mMinimum && rate_f64 <= range.mMaximum {
                        rates.push(standard_rate);
                        break;
                    }
                }
            }

            // Sort and deduplicate
            rates.sort();
            rates.dedup();

            Ok(rates)
        }
    }

    /// Enable Hog Mode (exclusive access)
    fn enable_hog_mode_internal(device_id: AudioObjectID) -> Result<()> {
        println!("[CoreAudio] Enabling Hog Mode for device {}...", device_id);

        unsafe {
            let property_address = AudioObjectPropertyAddress {
                mSelector: kAudioDevicePropertyHogMode,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            };

            // Get our process ID
            let pid: i32 = std::process::id() as i32;

            let status = AudioObjectSetPropertyData(
                device_id,
                &property_address,
                0,
                std::ptr::null(),
                std::mem::size_of::<i32>() as u32,
                &pid as *const _ as *const c_void,
            );

            if status != 0 {
                return Err(AudioBackendError::ExclusiveModeFailed(format!(
                    "Failed to enable Hog Mode: CoreAudio error {}",
                    status
                )));
            }

            println!("[CoreAudio] Hog Mode enabled successfully (PID: {})", pid);
            Ok(())
        }
    }

    /// Disable Hog Mode
    fn disable_hog_mode_internal(device_id: AudioObjectID) -> Result<()> {
        println!("[CoreAudio] Disabling Hog Mode for device {}...", device_id);

        unsafe {
            let property_address = AudioObjectPropertyAddress {
                mSelector: kAudioDevicePropertyHogMode,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            };

            // Set to -1 to release hog mode
            let pid: i32 = -1;

            let status = AudioObjectSetPropertyData(
                device_id,
                &property_address,
                0,
                std::ptr::null(),
                std::mem::size_of::<i32>() as u32,
                &pid as *const _ as *const c_void,
            );

            if status != 0 {
                return Err(AudioBackendError::ExclusiveModeFailed(format!(
                    "Failed to disable Hog Mode: CoreAudio error {}",
                    status
                )));
            }

            println!("[CoreAudio] Hog Mode disabled");
            Ok(())
        }
    }

    /// Get max channels for a device
    fn get_max_channels(device_id: AudioObjectID) -> u16 {
        unsafe {
            let property_address = AudioObjectPropertyAddress {
                mSelector: kAudioDevicePropertyStreamConfiguration,
                mScope: kAudioDevicePropertyScopeOutput,
                mElement: kAudioObjectPropertyElementMain,
            };

            let mut size: u32 = 0;
            let status = AudioObjectGetPropertyDataSize(
                device_id,
                &property_address,
                0,
                std::ptr::null(),
                &mut size,
            );

            if status != 0 || size == 0 {
                return 2; // Default to stereo
            }

            let mut buffer = vec![0u8; size as usize];
            let buffer_list = buffer.as_mut_ptr() as *mut AudioBufferList;

            let status = AudioObjectGetPropertyData(
                device_id,
                &property_address,
                0,
                std::ptr::null(),
                &mut size,
                buffer_list as *mut c_void,
            );

            if status != 0 {
                return 2;
            }

            // Sum channels across all buffers
            let num_buffers = (*buffer_list).mNumberBuffers as usize;
            let buffers = std::slice::from_raw_parts(
                (*buffer_list).mBuffers.as_ptr(),
                num_buffers,
            );

            let total_channels: u32 = buffers.iter().map(|b| b.mNumberChannels).sum();
            total_channels as u16
        }
    }

    /// Find the best supported sample rate for a given source rate
    /// Prioritizes: exact match > higher rate > highest available
    fn find_best_supported_rate(source_rate: u32, supported_rates: &[u32]) -> u32 {
        if supported_rates.is_empty() {
            return 44100; // Safe fallback
        }

        // First, try to find an exact match
        if supported_rates.contains(&source_rate) {
            return source_rate;
        }

        // Try to find the smallest supported rate >= source_rate
        let higher_rates: Vec<u32> = supported_rates
            .iter()
            .filter(|&&r| r >= source_rate)
            .copied()
            .collect();

        if let Some(&rate) = higher_rates.iter().min() {
            return rate;
        }

        // If no higher rate, use the highest available
        *supported_rates.iter().max().unwrap_or(&44100)
    }

    /// Refresh the device cache
    fn refresh_device_cache(&mut self) -> Result<()> {
        let device_ids = Self::get_all_output_devices()?;
        let default_id = Self::get_default_output_device().ok();

        self.device_cache.clear();

        for device_id in device_ids {
            let name = Self::get_device_name(device_id).unwrap_or_else(|_| "Unknown".to_string());
            let current_rate = Self::get_device_sample_rate(device_id).unwrap_or(44100);
            let supported_rates = Self::get_supported_sample_rates(device_id).unwrap_or_default();
            let max_channels = Self::get_max_channels(device_id);

            let info = DeviceInfo {
                id: device_id.to_string(),
                name,
                manufacturer: None, // TODO: get manufacturer via kAudioObjectPropertyManufacturer
                is_default: Some(device_id) == default_id,
                supported_sample_rates: supported_rates,
                current_sample_rate: current_rate,
                max_channels,
                supports_exclusive: true, // All macOS devices support Hog Mode
            };

            self.device_cache.insert(device_id.to_string(), info);
        }

        Ok(())
    }
}

impl AudioBackend for CoreAudioBackend {
    fn list_devices(&self) -> Result<Vec<DeviceInfo>> {
        Ok(self.device_cache.values().cloned().collect())
    }

    fn current_device(&self) -> Result<DeviceInfo> {
        // Always get the CURRENT default device (follows system changes)
        let device_id = self.get_active_device_id()?;
        let id = device_id.to_string();
        self.device_cache
            .get(&id)
            .cloned()
            .ok_or_else(|| AudioBackendError::DeviceNotFound(id))
    }

    fn set_output_device(&mut self, device_id: &str) -> Result<()> {
        let id: AudioObjectID = device_id
            .parse()
            .map_err(|_| AudioBackendError::DeviceNotFound(device_id.to_string()))?;

        // Verify device exists
        if !self.device_cache.contains_key(device_id) {
            self.refresh_device_cache()?;
            if !self.device_cache.contains_key(device_id) {
                return Err(AudioBackendError::DeviceNotFound(device_id.to_string()));
            }
        }

        // Release exclusive mode on old device if needed
        if self.exclusive_mode == ExclusiveMode::Exclusive {
            let _ = Self::disable_hog_mode_internal(self.last_device_id);
        }

        // Set manual device (stops following system default)
        self.manual_device_id = Some(id);
        self.last_device_id = id;

        println!("[CoreAudio] Manually switched to device: {}", device_id);
        Ok(())
    }

    fn get_device_info(&self, device_id: &str) -> Result<DeviceInfo> {
        self.device_cache
            .get(device_id)
            .cloned()
            .ok_or_else(|| AudioBackendError::DeviceNotFound(device_id.to_string()))
    }

    fn current_sample_rate(&self) -> Result<u32> {
        let device_id = self.get_active_device_id()?;
        Self::get_device_sample_rate(device_id)
    }

    fn set_sample_rate(&mut self, rate: u32) -> Result<()> {
        let device_id = self.get_active_device_id()?;

        // Store original rate for this device if not already saved
        if !self.original_sample_rates.contains_key(&device_id) {
            if let Ok(original) = Self::get_device_sample_rate(device_id) {
                self.original_sample_rates.insert(device_id, original);
            }
        }

        Self::set_device_sample_rate_internal(device_id, rate)?;

        // Update cache
        let id = device_id.to_string();
        if let Some(info) = self.device_cache.get_mut(&id) {
            info.current_sample_rate = rate;
        }

        Ok(())
    }

    fn is_sample_rate_supported(&self, rate: u32) -> bool {
        let device_id = match self.get_active_device_id() {
            Ok(id) => id,
            Err(_) => return false,
        };
        let id = device_id.to_string();
        self.device_cache
            .get(&id)
            .map(|info| info.supported_sample_rates.contains(&rate))
            .unwrap_or(false)
    }

    fn supported_sample_rates(&self) -> Result<Vec<u32>> {
        let device_id = self.get_active_device_id()?;
        let id = device_id.to_string();
        self.device_cache
            .get(&id)
            .map(|info| info.supported_sample_rates.clone())
            .ok_or_else(|| AudioBackendError::DeviceNotFound(id))
    }

    fn exclusive_mode(&self) -> ExclusiveMode {
        self.exclusive_mode
    }

    fn set_exclusive_mode(&mut self, mode: ExclusiveMode) -> Result<()> {
        let device_id = self.get_active_device_id()?;

        if mode == self.exclusive_mode {
            return Ok(());
        }

        match mode {
            ExclusiveMode::Exclusive => {
                Self::enable_hog_mode_internal(device_id)?;
            }
            ExclusiveMode::Shared => {
                Self::disable_hog_mode_internal(device_id)?;
            }
        }

        self.exclusive_mode = mode;
        Ok(())
    }

    fn set_device_event_callback(&mut self, callback: Option<DeviceEventCallback>) {
        self.event_callback = callback;
        // TODO: Register property listeners with CoreAudio for device changes
        // AudioObjectAddPropertyListener(...)
    }

    fn get_cpal_device(&self) -> Result<cpal::Device> {
        // CRITICAL FIX: Always use CPAL's default device to follow system changes
        // When user plugs in headphones or DAC, CPAL's default_output_device() returns the new device
        let host = cpal::default_host();

        let device = host.default_output_device()
            .ok_or_else(|| AudioBackendError::DeviceNotFound("No default output device".to_string()))?;

        // Log the device we're using
        if let Ok(name) = device.name() {
            println!("[CoreAudio] Using CPAL device: {}", name);
        }

        Ok(device)
    }

    fn prepare_for_streaming(&mut self, config: &StreamConfig) -> Result<u32> {
        // Check if device has changed (user plugged in headphones/DAC)
        self.check_device_change();

        // Refresh cache to get latest device info
        let _ = self.refresh_device_cache();

        let device_id = self.get_active_device_id()?;

        println!(
            "[CoreAudio] Preparing for streaming at {} Hz on device {}...",
            config.sample_rate, device_id
        );

        // ALWAYS try to set the sample rate, even if it looks the same
        // This ensures we adapt to the current device's capabilities
        let current_rate = Self::get_device_sample_rate(device_id)?;

        // Check if the requested rate is supported
        let id_str = device_id.to_string();
        let supported_rates = self.device_cache
            .get(&id_str)
            .map(|info| info.supported_sample_rates.clone())
            .unwrap_or_default();

        let target_rate = if supported_rates.contains(&config.sample_rate) {
            // Exact rate is supported
            config.sample_rate
        } else {
            // Find the best supported rate
            CoreAudioBackend::find_best_supported_rate(config.sample_rate, &supported_rates)
        };

        if current_rate != target_rate {
            println!(
                "[CoreAudio] Changing sample rate: {} Hz -> {} Hz",
                current_rate, target_rate
            );
            self.set_sample_rate(target_rate)?;
        } else {
            println!("[CoreAudio] Sample rate already at {} Hz", target_rate);
        }

        // Enable exclusive mode if configured
        if self.exclusive_mode == ExclusiveMode::Exclusive {
            Self::enable_hog_mode_internal(device_id)?;
        }

        Ok(target_rate)
    }

    fn release(&mut self) -> Result<()> {
        println!("[CoreAudio] Releasing resources...");

        // Release Hog Mode on current device
        if self.exclusive_mode == ExclusiveMode::Exclusive {
            if let Ok(device_id) = self.get_active_device_id() {
                let _ = Self::disable_hog_mode_internal(device_id);
            }
            self.exclusive_mode = ExclusiveMode::Shared;
        }

        // Restore original sample rates for all modified devices
        for (device_id, original_rate) in self.original_sample_rates.drain() {
            println!(
                "[CoreAudio] Restoring device {} to original sample rate: {} Hz",
                device_id, original_rate
            );
            let _ = Self::set_device_sample_rate_internal(device_id, original_rate);
        }

        println!("[CoreAudio] Resources released");
        Ok(())
    }

    fn name(&self) -> &'static str {
        "CoreAudio"
    }
}

impl Drop for CoreAudioBackend {
    fn drop(&mut self) {
        // CRITICAL: Ensure cleanup on drop (even on panic/crash)
        if let Err(e) = self.release() {
            eprintln!("[CoreAudio] Error during drop cleanup: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backend_creation() {
        let backend = CoreAudioBackend::new();
        assert!(backend.is_ok(), "Failed to create CoreAudio backend");
    }

    #[test]
    fn test_device_enumeration() {
        let backend = CoreAudioBackend::new().unwrap();
        let devices = backend.list_devices().unwrap();
        assert!(!devices.is_empty(), "No audio devices found");

        for device in &devices {
            println!(
                "Device: {} (ID: {}, Default: {}, Rates: {:?})",
                device.name, device.id, device.is_default, device.supported_sample_rates
            );
        }
    }

    #[test]
    fn test_current_sample_rate() {
        let backend = CoreAudioBackend::new().unwrap();
        let rate = backend.current_sample_rate().unwrap();
        assert!(rate > 0, "Invalid sample rate: {}", rate);
        println!("Current sample rate: {} Hz", rate);
    }
}
