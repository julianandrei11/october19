import { Component, ViewChild, ElementRef, ChangeDetectorRef, OnInit } from '@angular/core';
import { Platform, ModalController, NavController, AlertController } from '@ionic/angular';
import { ActivatedRoute, Router } from '@angular/router';
import { MediaService } from '../services/media.service';
import { FirebaseService } from '../services/firebase.service';

// Native file persistence for images/audio
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

type UUID = string;

interface UserCategory {
  id: UUID;
  name: string;
  description?: string;
  emoji?: string;
  createdAt: number;
}

type BuiltinCat = 'people' | 'objects' | 'places';

interface BuiltinCard {
  label: string;
  image: string | null;
  audio: string | null;
  duration: number;
}

const CATEGORIES_KEY = 'alala_custom_categories_v1';
const CARDS_PREFIX   = 'alala_cards_';
const MAX_RECORDING_TIME = 120; // 2 minutes in seconds

// ---- Encoding shim (works across Capacitor versions) ----
const FS_BASE64: any = ((): any => {
  try {
    // If enum exists and has BASE64, use it
    // @ts-ignore
    if (Encoding && (Encoding as any).BASE64) return (Encoding as any).BASE64;
  } catch {}
  // Fallback to literal string; we’ll cast to any when we pass it
  return 'base64';
})();

@Component({
  selector: 'app-add-flashcard',
  templateUrl: './add-flashcard.page.html',
  styleUrls: ['./add-flashcard.page.scss'],
  standalone: false,
})
export class AddFlashcardPage implements OnInit {
  name = '';
  image: string | null = null;
  audio: string | null = null;

  // Built-in category (default)
  category: BuiltinCat = 'people';

  // Target selection
  activeTarget: 'builtin' | 'custom' = 'builtin';
  customCategories: UserCategory[] = [];
  selectedCustomCategoryId: string | null = null;

  // From navigation (pre-select a custom target)
  defaultCategoryId: string | null = null;
  defaultCategoryName: string | null = null;

  // Edit mode
  isEditMode = false;
  editCardId: string | null = null;

  isRecording = false;
  recordingTime = '00:00';
  recordingLimitReached = false;
  private recordingInterval: any;
  private recordingStartTime = 0;

  isPlaying = false;
  currentTime = 0;
  audioDuration: number = 0;

  isSaving = false;

  @ViewChild('audioPlayer', { static: false }) audioPlayer!: ElementRef<HTMLAudioElement>;

  constructor(
    private platform: Platform,
    private modalCtrl: ModalController,
    private nav: NavController,
    public  mediaService: MediaService,
    private cdr: ChangeDetectorRef,
    private router: Router,
    private route: ActivatedRoute,
    private firebaseService: FirebaseService,
    private alertCtrl: AlertController
  ) {}

  ngOnInit() {
    const st = (this.router.getCurrentNavigation()?.extras?.state || {}) as any;
    const stateId: string | undefined = st.defaultCategoryId;
    const stateName: string | undefined = st.defaultCategoryName;
    const qpId = this.route.snapshot.queryParamMap.get('defaultCategoryId') || undefined;
    const qpBuiltin = this.route.snapshot.queryParamMap.get('defaultCategory');
    const qpEditCardId = this.route.snapshot.queryParamMap.get('editCardId') || undefined;
    const qpEditLabel = this.route.snapshot.queryParamMap.get('editLabel') || undefined;

    this.defaultCategoryId = (stateId || qpId || null);
    this.defaultCategoryName = stateName || null;

    // Check if in edit mode
    if (qpEditCardId) {
      this.isEditMode = true;
      this.editCardId = qpEditCardId;
      this.name = qpEditLabel || '';
    }

    this.customCategories = this.getAllCategories();

    if (this.defaultCategoryId && this.customCategories.some(c => c.id === this.defaultCategoryId)) {
      this.activeTarget = 'custom';
      this.selectedCustomCategoryId = this.defaultCategoryId;
    } else if (qpBuiltin && ['people','objects','places'].includes(qpBuiltin)) {
      this.activeTarget = 'builtin';
      this.category = qpBuiltin as BuiltinCat;
    }
  }

  /* ---------- Modal ---------- */
  private async safeDismiss(result?: any): Promise<void> {
    try {
      const top = await this.modalCtrl.getTop();
      if (top) {
        await top.dismiss(result);
      } else {
        this.nav.back();
      }
    } catch {
      this.nav.back();
    }
  }
  public closeModal(result?: any): Promise<void> {
    return this.safeDismiss(result);
  }

  /* ---------- Storage helpers for custom categories ---------- */
  private getAllCategories(): UserCategory[] {
    try {
      const user = this.firebaseService.getCurrentUser();
      const userSpecificKey = user ? `${CATEGORIES_KEY}_${user.uid}` : CATEGORIES_KEY;
      const raw = localStorage.getItem(userSpecificKey);
      return raw ? (JSON.parse(raw) as UserCategory[]) : [];
    } catch {
      return [];
    }
  }

  private cardsKeyFor(id: string): string {
    return `${CARDS_PREFIX}${id}`;
  }

  /* ---------- Target switching ---------- */
  selectTarget(t: 'builtin' | 'custom') {
    this.activeTarget = t;
    if (t === 'builtin') {
      this.selectedCustomCategoryId = null;
    } else {
      if (!this.selectedCustomCategoryId && this.customCategories.length > 0) {
        this.selectedCustomCategoryId = this.customCategories[0].id;
      }
    }
  }

  selectCustomCategory(id: string) {
    this.activeTarget = 'custom';
    this.selectedCustomCategoryId = id;
  }

  clearCustomSelection() {
    if (this.activeTarget !== 'builtin') this.activeTarget = 'builtin';
    this.selectedCustomCategoryId = null;
  }

  /* ---------- Image ---------- */
  async takePhoto() {
    try { this.image = await this.mediaService.takePhoto(); }
    catch (e) { console.error(e); alert('Failed to take a photo.'); }
  }
  async selectImage() {
    try { this.image = await this.mediaService.chooseFromGallery(); }
    catch (e) { console.error(e); alert('Failed to select image.'); }
  }

  /* ---------- Audio: file ---------- */
  async selectAudio() {
    try {
      console.log('Starting audio file selection...');
      const asset = await this.mediaService.pickAudioFile();
      console.log('Audio file selected:', asset);
      
      if (asset && (asset as any).base64) {
        this.audio = (asset as any).base64; // data URL
        console.log('Using base64 data URL');
      } else if (asset?.url?.startsWith('blob:')) {
        console.log('Converting blob URL to data URL');
        this.audio = await this.blobUrlToDataUrl(asset.url);
      } else {
        this.audio = asset.url;
        console.log('Using direct URL:', asset.url);
      }
      
      console.log('Audio set, updating duration...');
      await this.updateAccurateDuration(this.audio!);
      console.log('Audio duration updated:', this.audioDuration);
      
      this.cdr.detectChanges();
    } catch (err) {
      console.error('Audio selection failed:', err);
      alert(`Audio selection failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async blobUrlToDataUrl(blobUrl: string): Promise<string> {
    const res = await fetch(blobUrl);
    const blob = await res.blob();
    return new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  /* ---------- Audio: record ---------- */
  async recordAudio() {
    if (this.isRecording) {
      try {
        clearInterval(this.recordingInterval);
        const stopAt = Date.now();
        const url = await this.mediaService.stopRecording();

        this.isRecording = false;
        this.recordingLimitReached = false;
        this.recordingTime = '00:00';
        this.audio = url;

        const measured = (stopAt - this.recordingStartTime) / 1000;
        await this.updateAccurateDuration(this.audio, measured);
      } catch (e) {
        console.error(e);
      }
      return;
    }
    try {
      await this.mediaService.recordAudio();
      this.isRecording = true;
      this.recordingLimitReached = false;
      this.recordingStartTime = Date.now();
      this.recordingInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);

        // Auto-stop recording if 2 minutes reached
        if (elapsed >= MAX_RECORDING_TIME) {
          clearInterval(this.recordingInterval);
          this.recordAudio(); // Stop recording
          alert('Recording limit reached (2 minutes maximum)');
          return;
        }

        // Show warning at 1:50 (110 seconds)
        if (elapsed >= 110 && !this.recordingLimitReached) {
          this.recordingLimitReached = true;
          console.warn('Recording approaching 2-minute limit');
        }

        const mm = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const ss = (elapsed % 60).toString().padStart(2, '0');
        this.recordingTime = `${mm}:${ss}`;
      }, 250);
    } catch (e) {
      console.error(e);
    }
  }

  startNewRecording() {
    this.audio = null;
    this.isPlaying = false;
    this.currentTime = 0;
    this.audioDuration = 0;
    this.recordAudio();
  }

  /* ---------- Player ---------- */
  togglePlayback() {
    if (!this.audioPlayer) return;
    const el = this.audioPlayer.nativeElement;
    if (this.isPlaying) {
      el.pause();
      this.isPlaying = false;
    } else {
      el.play().then(() => this.isPlaying = true).catch(err => {
        console.error('Audio play failed:', err);
        this.isPlaying = false;
      });
    }
  }
  seekAudio(ev: any) {
    if (!this.audioPlayer) return;
    const t = Number(ev.detail.value ?? 0);
    if (isFinite(t)) this.audioPlayer.nativeElement.currentTime = t;
  }
  onAudioLoaded() {
    const d = this.audioPlayer?.nativeElement?.duration ?? 0;
    if (isFinite(d) && d > 0) { this.audioDuration = d; this.cdr.markForCheck(); }
  }
  onTimeUpdate() {
    if (this.audioPlayer) {
      const t = this.audioPlayer.nativeElement.currentTime;
      this.currentTime = isFinite(t) ? t : 0;
    }
  }
  onAudioEnded() {
    this.isPlaying = false;
    this.currentTime = 0;
    if (this.audioPlayer) this.audioPlayer.nativeElement.currentTime = 0;
  }
  onAudioPause() { this.isPlaying = false; }
  onAudioPlay()  { this.isPlaying = true;  }
  removeAudio() {
    this.audio = null;
    this.isPlaying = false;
    this.currentTime = 0;
    this.audioDuration = 0;
  }
  formatTime(n: number) {
    if (!isFinite(n) || isNaN(n) || n < 0) return '00:00';
    const m = Math.floor(n / 60);
    const s = Math.floor(n % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /* ---------- Audio validation ---------- */
  private async showAudioDurationError() {
    const alert = await this.alertCtrl.create({
      header: 'Audio Too Long',
      message: 'Audio files must be 2 minutes or less. Please select a shorter audio file.',
      buttons: ['OK'],
      cssClass: 'audio-duration-alert'
    });
    await alert.present();
  }

  /* ---------- Duration helpers ---------- */
  private async updateAccurateDuration(url: string, measuredSeconds?: number) {
    const decoded = await this.tryDecodeDuration(url);
    if (decoded && isFinite(decoded) && decoded > 0) {
      this.audioDuration = decoded;
    } else {
      const meta = await this.computeDetachedDuration(url);
      this.audioDuration = meta ?? 0;
    }
    if (measuredSeconds && isFinite(this.audioDuration)) {
      if (measuredSeconds - this.audioDuration > 0.25) {
        this.audioDuration = Math.max(this.audioDuration, measuredSeconds);
      }
    }

    // Check if audio duration exceeds 2 minutes (120 seconds)
    if (this.audioDuration > 120) {
      this.showAudioDurationError();
      // Remove the audio and reset duration
      this.audio = null;
      this.audioDuration = 0;
      return;
    }
  }

  private async tryDecodeDuration(url: string): Promise<number | null> {
    try {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      const ctx = new AC();
      const decode = (data: ArrayBuffer) =>
        new Promise<AudioBuffer>((resolve, reject) => {
          const ret = (ctx as any).decodeAudioData(
            data,
            (b: AudioBuffer) => resolve(b),
            (e: any) => reject(e)
          );
          if (ret && typeof (ret as Promise<AudioBuffer>).then === 'function') {
            (ret as Promise<AudioBuffer>).then(resolve).catch(reject);
          }
        });
      const audioBuffer = await decode(buf);
      const dur = audioBuffer?.duration ?? 0;
      try { ctx.close(); } catch {}
      return dur && isFinite(dur) ? dur : null;
    } catch {
      return null;
    }
  }

  private async computeDetachedDuration(url: string): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      const el = new Audio();
      el.preload = 'metadata';
      el.src = url;
      const cleanup = () => { el.src = ''; };
      el.onloadedmetadata = () => {
        if (isFinite(el.duration) && el.duration > 0) {
          const d = el.duration; cleanup(); resolve(d);
        } else {
          el.onseeked = () => {
            const d = isFinite(el.duration) ? el.duration : 0;
            cleanup(); resolve(d || null);
          };
          try { el.currentTime = 1e6; }
          catch { cleanup(); resolve(null); }
        }
      };
      el.onerror = () => { cleanup(); resolve(null); };
    });
  }

  /* ---------- Media persistence helpers ---------- */
  private async shrinkDataUrl(dataUrl: string, maxDim = 1280, quality = 0.8): Promise<string> {
    if (!dataUrl.startsWith('data:image/')) return dataUrl;

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = dataUrl;
    });

    let { width, height } = img;
    if (width <= maxDim && height <= maxDim) return dataUrl;

    const ratio = width / height;
    if (width > height) {
      width = maxDim; height = Math.round(width / ratio);
    } else {
      height = maxDim; width = Math.round(height * ratio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', quality) || dataUrl;
  }

  private dataUrlToBase64(dataUrl: string): string {
    const i = dataUrl.indexOf(',');
    return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  }

  private async persistDataUrlToFilesystem(dataUrl: string, prefix: 'img' | 'aud', fallbackExt: string): Promise<string> {
    try {
      const match = /^data:([^;]+)/.exec(dataUrl);
      const mime = match?.[1] || '';
      const extFromMime =
        mime.includes('jpeg') ? 'jpg' :
        mime.includes('jpg')  ? 'jpg' :
        mime.includes('png')  ? 'png' :
        mime.includes('webp') ? 'webp' :
        mime.includes('ogg')  ? 'ogg' :
        mime.includes('webm') ? 'webm' :
        mime.includes('mp3')  ? 'mp3' :
        mime.includes('m4a')  ? 'm4a' :
        mime.includes('aac')  ? 'aac' : fallbackExt;

      const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}.${extFromMime}`;
      const dataToWrite = prefix === 'img' ? await this.shrinkDataUrl(dataUrl) : dataUrl;
      const base64 = this.dataUrlToBase64(dataToWrite);

      // NOTE: cast to any to satisfy differing Capacitor types across versions
      const write = await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: Directory.Data,
        encoding: FS_BASE64 as any,
        recursive: true
      } as any);

      return Capacitor.convertFileSrc((write as any).uri || (write as any).path || '');
    } catch (e) {
      console.warn('persistDataUrlToFilesystem failed; trying tiny fallback', e);
      if (prefix === 'img') {
        try {
          const tiny = await this.shrinkDataUrl(dataUrl, 640, 0.7);
          const base64 = this.dataUrlToBase64(tiny);
          const fallbackName = `${prefix}_tiny_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
          const writeTiny = await Filesystem.writeFile({
            path: fallbackName,
            data: base64,
            directory: Directory.Data,
            encoding: FS_BASE64 as any,
            recursive: true
          } as any);
          return Capacitor.convertFileSrc((writeTiny as any).uri || (writeTiny as any).path || '');
        } catch (e2) {
          console.error('Tiny image fallback failed; using original data URL', e2);
          return dataUrl; // last resort
        }
      }
      return dataUrl;
    }
  }

  private async ensurePersistentSrc(src: string | null, prefix: 'img' | 'aud', fallbackExt: string): Promise<string | null> {
    if (!src) return null;

    if (/^(https?:|capacitor:|file:)/i.test(src)) return src;
    const isWeb = Capacitor.getPlatform() === 'web';

    if (isWeb) {
      if (prefix === 'img' && src.startsWith('data:image/')) {
        return await this.shrinkDataUrl(src, 1280, 0.8);
      }
      return src;
    }

    if (src.startsWith('data:')) {
      return await this.persistDataUrlToFilesystem(src, prefix, fallbackExt);
    }

    return src;
  }

  /* ---------- Safe localStorage ops with quota handling ---------- */
  private safeGetArray<T = any>(key: string): T[] {
    try {
      return JSON.parse(localStorage.getItem(key) || '[]') as T[];
    } catch {
      return [];
    }
  }

  private async normalizeMedia(list: BuiltinCard[]): Promise<BuiltinCard[]> {
    const out: BuiltinCard[] = [];
    for (const item of list) {
      const normImage = item.image ? await this.ensurePersistentSrc(item.image, 'img', 'jpg') : null;
      const normAudio = item.audio ? await this.ensurePersistentSrc(item.audio, 'aud', 'm4a') : null;
      out.push({
        label: item.label,
        image: normImage || null,
        audio: normAudio || null,
        duration: Number(item.duration || 0)
      });
    }
    return out;
  }

  private trySaveWithTrim(key: string, arr: any[], minKeep = 1): void {
    let copy = arr.slice();
    while (copy.length >= minKeep) {
      try {
        localStorage.setItem(key, JSON.stringify(copy));
        return;
      } catch (e) {
        copy.splice(0, Math.min(3, copy.length - minKeep));
        if (copy.length < minKeep) break;
      }
    }
    try {
      const lastOne = arr.slice(-minKeep);
      localStorage.setItem(key, JSON.stringify(lastOne));
    } catch (e2) {
      console.error('Still cannot save after trimming. Storage is full.', e2);
      throw e2;
    }
  }

  /* ---------- Audio Persistence ---------- */
  private async persistAudioLocally(audioDataUrl: string): Promise<string> {
    // Store audio as data URL in Firestore for cross-device playback
    // The audio is already compressed by the recorder (2-minute limit keeps size reasonable)

    // If it's already a URL (not a data URL), return as-is
    if (!audioDataUrl.startsWith('data:')) {
      return audioDataUrl;
    }

    // For data URLs, we store them directly
    // The 2-minute recording limit ensures the size stays manageable
    return audioDataUrl;
  }

  /* ---------- Save / Update ---------- */
  async saveFlashcard() {
    if (this.isSaving) return;
    if (!this.name) {
      alert('Please enter a name.');
      return;
    }
    if (!this.isEditMode && !this.image) {
      alert('Please select a photo.');
      return;
    }
    if (this.activeTarget === 'custom' && !this.selectedCustomCategoryId) {
      alert('Please choose one of your categories.');
      return;
    }

    this.isSaving = true;

    try {
      // In edit mode, image might not change
      const imageSrc = this.image ? await this.ensurePersistentSrc(this.image, 'img', 'jpg') : null;

      // Persist audio locally (device filesystem) instead of Firebase Storage
      let audioSrc: string | null = null;
      if (this.audio) {
        try {
          console.log('Persisting audio...');
          audioSrc = await this.persistAudioLocally(this.audio);
          console.log('Audio persisted successfully:', audioSrc ? 'Yes' : 'No');
        } catch (err) {
          console.error('Audio persistence failed:', err);
          // Continue without audio rather than failing the entire save
        }
      }

      // Handle edit mode
      if (this.isEditMode && this.editCardId) {
        const updates: any = { label: this.name };
        if (imageSrc) updates.src = imageSrc;
        if (audioSrc) updates.audio = audioSrc;
        if (this.audio) updates.duration = this.audioDuration;

        try {
          console.log('Updating flashcard in Firebase with audio:', !!audioSrc);
          await this.firebaseService.updateStructuredFlashcard(this.editCardId, this.category, updates);
          console.log('Flashcard updated in Firebase');
        } catch (err) {
          console.error('Failed to update flashcard in Firebase:', err);
          console.warn('Failed to update flashcard in Firebase', err);
        }

        // Notify app listeners
        window.dispatchEvent(new CustomEvent('flashcard-updated', {
          detail: {
            cardId: this.editCardId,
            category: this.category,
            updates
          }
        }));
      } else {
        // Create new card
        const newCard: BuiltinCard = {
          label: this.name,
          image: imageSrc!,
          audio: audioSrc || null,
          duration: this.audio ? this.audioDuration : 0
        };

        if (this.activeTarget === 'builtin') {
          const storageKey = `${this.category}Cards` as const;
          // Scope to user
          const user = this.firebaseService.getCurrentUser();
          const uid = user ? user.uid : 'anon';
          const scopedKey = `${storageKey}_${uid}`;
          let existing = this.safeGetArray<BuiltinCard>(scopedKey);
          existing = await this.normalizeMedia(existing);
          existing.push(newCard);
          this.trySaveWithTrim(scopedKey, existing, 1);

          // Save to Firebase structured userFlashcards
          try {
            console.log('Creating flashcard in Firebase with audio:', !!audioSrc);
            await this.firebaseService.createFlashcard({
              type: 'photo',
              label: this.name,
              src: imageSrc!,
              audio: audioSrc || null,
              duration: this.audio ? this.audioDuration : 0,
              category: this.category
            } as any);
            console.log('Flashcard saved to Firebase userFlashcards');
            
            // Show success confirmation
            const alert = await this.alertCtrl.create({
              header: 'Success!',
              message: 'Flashcard saved successfully!',
              buttons: ['OK']
            });
            await alert.present();
          } catch (err) {
            console.error('Failed to save flashcard to Firebase userFlashcards:', err);
            console.warn('Failed to save flashcard to Firebase userFlashcards', err);
            
            // Show error confirmation
            const alert = await this.alertCtrl.create({
              header: 'Error',
              message: 'Failed to save flashcard. Please try again.',
              buttons: ['OK']
            });
            await alert.present();
          }

          // Notify app listeners (same-device realtime)
          window.dispatchEvent(new CustomEvent('flashcard-added', {
            detail: {
              kind: 'builtin',
              category: this.category,
              card: newCard
            }
          }));
        } else {
          const targetId = this.selectedCustomCategoryId as string;
          const key = this.cardsKeyFor(targetId);
          const now = Date.now();
          const existingCustom = this.safeGetArray<any>(key);

          const customCard = {
            id: `${now.toString(36)}_${Math.random().toString(36).slice(2,8)}`,
            categoryId: targetId,
            type: 'photo' as const,
            src: imageSrc,
            label: this.name,
            audio: audioSrc || null,
            duration: this.audio ? this.audioDuration : 0,
            createdAt: now
          };
          existingCustom.push(customCard);
          this.trySaveWithTrim(key, existingCustom, 1);

          // Save to Firebase structured userFlashcards/custom-category
          try {
            console.log('Creating custom flashcard in Firebase with audio:', !!audioSrc);
            const customCategory = this.customCategories.find(c => c.id === targetId);
            await this.firebaseService.createFlashcard({
              type: 'photo',
              label: this.name,
              src: imageSrc!,
              audio: audioSrc || null,
              duration: this.audio ? this.audioDuration : 0,
              category: customCategory?.name || 'custom-category',
              categoryId: targetId
            } as any);
            console.log('Custom flashcard saved to Firebase userFlashcards');
            
            // Show success confirmation
            const alert = await this.alertCtrl.create({
              header: 'Success!',
              message: 'Custom flashcard saved successfully!',
              buttons: ['OK']
            });
            await alert.present();
          } catch (err) {
            console.error('Failed to save custom flashcard to Firebase userFlashcards:', err);
            console.warn('Failed to save custom flashcard to Firebase userFlashcards', err);
            
            // Show error confirmation
            const alert = await this.alertCtrl.create({
              header: 'Error',
              message: 'Failed to save custom flashcard. Please try again.',
              buttons: ['OK']
            });
            await alert.present();
          }

          // Notify app listeners (same-device realtime)
          window.dispatchEvent(new CustomEvent('flashcard-added', {
            detail: {
              kind: 'custom',
              customCategoryId: targetId,
              card: customCard
            }
          }));
        }
      }

      // Navigate back to the originating list (People/Objects/Places or Custom Category)
      try {
        if (this.activeTarget === 'builtin') {
          const dest = this.category === 'people' ? '/people' : this.category === 'objects' ? '/objects' : '/places';
          await this.safeDismiss();
          this.router.navigate([dest]);
        } else if (this.selectedCustomCategoryId) {
          await this.safeDismiss();
          this.router.navigate(['/category', this.selectedCustomCategoryId]);
        } else {
          await this.closeModal();
        }
      } catch {
        await this.closeModal();
      }
    } catch (e) {
      console.error(e);
      alert('Failed to save. Storage is full — the newest item was kept. Consider deleting a few older flashcards.');
    } finally {
      this.isSaving = false;
    }
  }
}
