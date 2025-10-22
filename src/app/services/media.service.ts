import { Injectable } from '@angular/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FilePicker } from '@capawesome/capacitor-file-picker';

@Injectable({ providedIn: 'root' })
export class MediaService {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: BlobPart[] = [];
  private isRecording = false;
  private stream: MediaStream | null = null;
  private webMime = 'audio/webm;codecs=opus';

  constructor() {}

  /* -------------------- IMAGE -------------------- */
  async takePhoto(): Promise<string> {
    const image = await Camera.getPhoto({
      quality: 80,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Camera,
    });
    return image.dataUrl!;
  }

  async chooseFromGallery(): Promise<string> {
    const image = await Camera.getPhoto({
      quality: 80,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Photos,
    });
    return image.dataUrl!;
  }

  /* -------------------- AUDIO RECORD -------------------- */
  async recordAudio(): Promise<void> {
    if (this.isRecording) throw new Error('Already recording');

    // Request microphone permission and start recording using Web Audio API
    // This works on both web and native platforms through Capacitor's WebView
    const constraints: MediaStreamConstraints = {
      audio: { 
        echoCancellation: true, 
        noiseSuppression: true, 
        sampleRate: 44100,
        channelCount: 1 // Mono recording for better compatibility
      },
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      console.error('Failed to get microphone access:', error);
      throw new Error('Microphone permission denied or not available');
    }

    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
    ];
    const supported = candidates.find((c) => (window as any).MediaRecorder?.isTypeSupported?.(c));
    this.webMime = supported ?? 'audio/webm';

    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: this.webMime });
    this.audioChunks = [];

    // Resolve only when the recorder actually starts
    await new Promise<void>((resolve, reject) => {
      const onStart = () => {
        this.mediaRecorder!.removeEventListener('start', onStart);
        this.isRecording = true;
        resolve();
      };
      const onError = (e: any) => {
        this.mediaRecorder?.removeEventListener('start', onStart);
        console.error('MediaRecorder error', e);
        this.cleanup();
        reject(e);
      };

      this.mediaRecorder!.addEventListener('start', onStart);
      this.mediaRecorder!.addEventListener('error', onError);

      this.mediaRecorder!.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.audioChunks.push(e.data);
      };

      try {
        this.mediaRecorder!.start(); // no timeslice → capture from the exact start
      } catch (err) {
        onError(err);
      }
    });
  }


  async stopRecording(): Promise<string> {
    if (!this.isRecording) throw new Error('Not currently recording');

    // Convert blob to data URL for persistent storage
    const dataUrl = await new Promise<string>((resolve, reject) => {
      if (!this.mediaRecorder) {
        this.cleanup();
        return reject(new Error('No active recorder'));
      }

      this.mediaRecorder.onstop = async () => {
        try {
          if (!this.audioChunks.length) throw new Error('No audio data recorded');
          const mime = this.webMime.includes('ogg') ? 'audio/ogg' : 
                      this.webMime.includes('mp4') ? 'audio/mp4' : 'audio/webm';
          const blob = new Blob(this.audioChunks, { type: mime });

          // Convert blob to data URL for persistent storage
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            this.cleanup();
            resolve(result);
          };
          reader.onerror = (err) => {
            this.cleanup();
            reject(err);
          };
          reader.readAsDataURL(blob);
        } catch (err) {
          this.cleanup();
          reject(err);
        }
      };

      this.mediaRecorder!.stop();
    });

    // Optional: persist to filesystem for native platforms
    if (Capacitor.isNativePlatform()) {
      try {
        const base64 = dataUrl.split(',')[1];
        const ext = this.webMime.includes('mp4') ? 'm4a' : 
                   this.webMime.includes('ogg') ? 'ogg' : 'webm';
        await Filesystem.writeFile({
          path: `voice_recording_${Date.now()}.${ext}`,
          data: base64,
          directory: Directory.Data,
        });
      } catch (error) {
        console.warn('Failed to save recording to filesystem:', error);
      }
    }

    return dataUrl;
  }

  isCurrentlyRecording(): boolean {
    return this.isRecording;
  }

  /* -------------------- PICK AUDIO FILE -------------------- */
  async pickAudioFile(): Promise<{ url: string; base64?: string; mimeType: string; fileName?: string }> {
    try {
      console.log('MediaService: Starting file picker...');
      const result = await FilePicker.pickFiles({ types: ['audio/*'] });
      console.log('MediaService: File picker result:', result);
      
      if (!result.files?.length) {
        console.log('MediaService: No files selected');
        throw new Error('No audio selected');
      }
      
      const f = result.files[0];
      console.log('MediaService: Selected file:', f);

      // Web: Blob available - convert to data URL for persistent storage
      if ((f as any).blob) {
        console.log('MediaService: Processing blob file');
        const blob: Blob = (f as any).blob;
        const base64 = await this.blobToDataUrl(blob);
        // Return data URL as both url and base64 for persistent storage
        return { url: base64, base64, mimeType: f.mimeType || blob.type || 'audio/mpeg', fileName: f.name };
      }

      // Base64 provided by plugin - already in data URL format
      if ((f as any).data) {
        console.log('MediaService: Processing base64 data');
        const dataUrl = (f as any).data.startsWith('data:')
          ? (f as any).data
          : `data:${f.mimeType || 'audio/mpeg'};base64,${(f as any).data}`;
        return { url: dataUrl, base64: dataUrl, mimeType: f.mimeType || 'audio/mpeg', fileName: f.name };
      }

      // Native path → convert for WebView playback
      if (f.path) {
        console.log('MediaService: Processing native path');
        const webviewUrl = Capacitor.convertFileSrc(f.path);
        return { url: webviewUrl, mimeType: f.mimeType || 'audio/mpeg', fileName: f.name };
      }

      console.error('MediaService: Unsupported file payload:', f);
      throw new Error('Unsupported file payload from picker');
    } catch (error) {
      console.error('MediaService: File picker error:', error);
      throw error;
    }
  }

  /* -------------------- INTERNAL -------------------- */
  private cleanup() {
    this.isRecording = false;
    this.audioChunks = [];
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.mediaRecorder = null;
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  private async dataUrlToBlob(dataUrl: string): Promise<Blob> {
    const res = await fetch(dataUrl);
    return await res.blob();
  }
}
