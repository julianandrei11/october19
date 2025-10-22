import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren,
  NgZone,
} from '@angular/core';
import { ActionSheetController, AlertController, Platform, ToastController } from '@ionic/angular';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { FirebaseService } from '../../services/firebase.service';
import { Location } from '@angular/common';

interface VideoMeta {
  id: string;
  path: string;
  label?: string;
  createdAt: number;
  poster?: string;
}
interface VideoView extends VideoMeta { src: string; }

// Videos are now stored in Firebase only - no local storage needed

@Component({
  selector: 'app-video-memories',
  templateUrl: './video-memories.page.html',
  styleUrls: ['./video-memories.page.scss'],
  standalone: false,
})
export class VideoMemoriesPage implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('cameraInput') cameraInput!: ElementRef<HTMLInputElement>;
  @ViewChild('galleryInput') galleryInput!: ElementRef<HTMLInputElement>;
  @ViewChild('reels') reelsEl?: ElementRef<HTMLElement>;
  @ViewChildren('vidRef') vidRefs!: QueryList<ElementRef<HTMLVideoElement>>;
  @ViewChild('detailVideoRef') detailVideoRef!: ElementRef<HTMLVideoElement>;

  isPatientMode = false;
  private patientModeListener?: (e: any) => void;

  /** Source list (real items, newest first) */
  videos: VideoView[] = [];

  /** Display list for infinite loop: [last, ...videos, first] */
  displayVideos: VideoView[] = [];

  /** Per-REAL-index playback progress */
  progress: Array<{ current: number; duration: number }> = [];

  /** Inline edit */
  editingIndex: number | null = null;   // REAL index
  editLabel = '';

  /** Title expand/collapse (Patient Mode only) — uses DISPLAY index */
  private expandedTitleIndex: number | null = null;

  /** Scroll helpers */
  private cancelPressed = false;
  private scrollEndTimer: any = null;
  private isJumping = false;
  private currentDisplayIndex = 0;

  /** Gallery functionality */
  showDetailModal = false;
  selectedVideo: VideoView | null = null;
  selectedVideoIndex = -1;
  isDetailVideoPlaying = false;
  detailVideoCurrent = 0;
  detailVideoDuration = 0;

  constructor(
    private _plt: Platform,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
    private actionSheetCtrl: ActionSheetController,
    private alertCtrl: AlertController,
    private firebaseService: FirebaseService,
    private location: Location,
    private toastCtrl: ToastController,
  ) {}

  /* ---------- Lifecycle ---------- */

  async debugCheckFirebase() {
    console.log('🔍 DEBUG: Checking Firebase videos...');
    try {
      const videos = await this.firebaseService.debugGetVideos();
      console.log('🔍 DEBUG: Found videos in Firebase:', videos);
      
      const toast = await this.toastCtrl.create({
        message: `Found ${videos.length} videos in Firebase`,
        duration: 3000,
        position: 'bottom'
      });
      await toast.present();
    } catch (error) {
      console.error('🔍 DEBUG: Error checking Firebase:', error);
    }
  }

  async ngOnInit() {
    this.syncPatientMode();
    this.patientModeListener = (e: any) => {
      this.zone.run(() => {
        this.isPatientMode = !!e?.detail;
        this.cdr.detectChanges();
      });
    };
    window.addEventListener('patientMode-changed', this.patientModeListener);
    
    // Listen for cross-page realtime video inserts
    window.addEventListener('video-added', this.onVideoAdded as any);
    
    // Initialize Firebase video subscription (this will load videos from Firebase)
    // Wait a bit for authentication to complete
    setTimeout(() => {
      this.attachVideosSubscription();
    }, 1000);
    
    // Initialize display and progress arrays
    this.rebuildDisplay();
    this.prepareProgress();
  }

  ngAfterViewInit(): void {
    // Ensure each <video> loops and autoresumes
    this.vidRefs.forEach(ref => {
      const v = ref.nativeElement;
      v.muted = true;
      v.loop = true;
      v.addEventListener('ended', () => { v.currentTime = 0; v.play().catch(() => {}); });
    });

    // Start at first REAL item (display index 1) when looping is active
    setTimeout(() => {
      const startDisplay = this.videos.length > 1 ? 1 : 0;
      this.jumpToPage(startDisplay);
    }, 0);
  }

  ionViewWillEnter() {
    this.syncPatientMode();
    this.cdr.detectChanges();
  }

  ngOnDestroy(): void {
    if (this.patientModeListener) {
      window.removeEventListener('patientMode-changed', this.patientModeListener);
    }
    window.removeEventListener('video-added', this.onVideoAdded as any);
    this.detachVideosSubscription();
  }

  private syncPatientMode() {
    this.isPatientMode = localStorage.getItem('patientMode') === 'true';
  }

  /* ---------- Infinite display helpers ---------- */

  private rebuildDisplay() {
    if (this.videos.length <= 1) {
      this.displayVideos = this.videos.slice();
    } else {
      const first = this.videos[0];
      const last = this.videos[this.videos.length - 1];
      this.displayVideos = [last, ...this.videos, first];
    }
    this.cdr.detectChanges();
  }

  /** Pure helper for building looped display array */
  private makeLoopDisplay(list: VideoView[]): VideoView[] {
    if (!list || list.length <= 1) return (list || []).slice();
    const first = list[0];
    const last = list[list.length - 1];
    return [last, ...list, first];
  }

  /** Map DISPLAY index -> REAL index in `videos` */
  realIndex(displayIndex: number): number {
    const n = this.videos.length;
    if (n <= 1) return Math.max(0, Math.min(displayIndex, n - 1));
    if (displayIndex === 0) return n - 1;       // head clone = last real
    if (displayIndex === n + 1) return 0;       // tail clone = first real
    return displayIndex - 1;                    // middle = shift by -1
  }

  private reelsHeight(): number {
    return this.reelsEl?.nativeElement.clientHeight || 0;
  }

  onReelsScroll() {
    if (this.isJumping) return;
    if (this.scrollEndTimer) clearTimeout(this.scrollEndTimer);
    // snap settle debounce
    this.scrollEndTimer = setTimeout(() => this.onScrollSettled(), 120);
  }

  private onScrollSettled() {
    const el = this.reelsEl?.nativeElement;
    if (!el) return;
    const h = this.reelsHeight();
    if (h <= 0) return;

    // which "page" are we closest to?
    const page = Math.round(el.scrollTop / h);
    const n = this.videos.length;

    if (n > 1) {
      // If we landed on a clone, instantly jump to the matching real page
      if (page === 0) { this.jumpToPage(n); return; }       // head clone -> last real
      if (page === n + 1) { this.jumpToPage(1); return; }   // tail clone -> first real
    }

    this.currentDisplayIndex = page;
    this.autoplayVisible(page);
  }

  private jumpToPage(page: number) {
    const el = this.reelsEl?.nativeElement;
    const h = this.reelsHeight();
    if (!el || h <= 0) return;
    this.isJumping = true;
    el.scrollTo({ top: page * h, behavior: 'auto' });
    this.currentDisplayIndex = page;
    this.autoplayVisible(page);
    // allow scroll handler again on next frame
    setTimeout(() => { this.isJumping = false; }, 0);
  }

  private autoplayVisible(displayIndex: number) {
    this.vidRefs?.forEach((ref, i) => {
      const v = ref.nativeElement;
      if (i === displayIndex) v.play().catch(() => {});
      else v.pause();
    });
  }

  /* ---------- Add flow ---------- */

  async openAddMenu() {
    if (this.isPatientMode) return;
    const sheet = await this.actionSheetCtrl.create({
      header: 'Add Video',
      buttons: [
        { text: 'Record with Camera', icon: 'camera', handler: () => this.cameraInput?.nativeElement.click() },
        { text: 'Pick from Files',   icon: 'folder-open', handler: () => this.galleryInput?.nativeElement.click() },
        { text: 'Cancel', role: 'cancel', icon: 'close' },
      ],
    });
    await sheet.present();
  }

  onCancelMouseDown() { this.cancelPressed = true; }

  onInputBlur(realIdx: number) {
    if (this.cancelPressed) {
      this.cancelPressed = false;
      this.cancelEdit();
      return;
    }
    this.saveEdit(realIdx);
  }

  async onFilePicked(event: Event, _source: 'camera' | 'gallery') {
    const input = event.target as HTMLInputElement;
    if (!input.files || !input.files.length) return;

    const file = input.files[0];
    const suggested = (file.name || '').replace(/\.[^.]+$/, '');
    const label = await this.promptForName('Add video name (optional)', suggested);

    try {
      // Upload video directly to Firebase Storage
      const saved = await this.saveVideoFile(file, (label ?? '').trim() || undefined);
      
      // Video is now saved to Firebase and will appear via subscription
      setTimeout(() => this.jumpToPage(this.videos.length > 1 ? 1 : 0), 0);
      input.value = '';
      
      // Show success message
      const toast = await this.toastCtrl.create({
        message: 'Video saved successfully!',
        duration: 2000,
        position: 'bottom'
      });
      await toast.present();
    } catch (error) {
      console.error('Failed to save video:', error);
      const toast = await this.toastCtrl.create({
        message: 'Failed to save video. Please try again.',
        duration: 3000,
        position: 'bottom',
        color: 'danger'
      });
      await toast.present();
    }
  }

  /* ---------- Inline title editing ---------- */

  startEdit(displayIdx: number) {
    if (this.isPatientMode) return;
    const ri = this.realIndex(displayIdx);
    this.editingIndex = ri;
    this.editLabel = (this.videos[ri].label || '').trim();
  }

  onEditLabelInput(ev: any) {
    const val = ev?.detail?.value ?? ev?.target?.value ?? '';
    this.editLabel = val;
  }

  async saveEdit(realIdx: number) {
    if (this.editingIndex !== realIdx) return;
    const newLabel = (this.editLabel || '').trim();
    const video = this.videos[realIdx];
    
    try {
      // Update video title in Cloudinary and Firestore
      await this.firebaseService.updateVideoMetadata(video.id, { title: newLabel || undefined });
      
      // Update local data
      this.videos[realIdx].label = newLabel || undefined;
      this.editingIndex = null;
      this.editLabel = '';
      
      // Show success message
      const toast = await this.toastCtrl.create({
        message: 'Video title updated!',
        duration: 2000,
        position: 'bottom'
      });
      await toast.present();
      
      this.cdr.detectChanges();
    } catch (error) {
      console.error('Failed to update video title:', error);
      const toast = await this.toastCtrl.create({
        message: 'Failed to update video title. Please try again.',
        duration: 3000,
        position: 'bottom',
        color: 'danger'
      });
      await toast.present();
    }
  }

  cancelEdit() {
    this.editingIndex = null;
    this.editLabel = '';
  }

  /* ---------- Title expand/collapse (TikTok-like) ---------- */

  isTitleExpanded(displayIdx: number): boolean {
    return this.expandedTitleIndex === displayIdx;
  }

  onTitleTap(displayIdx: number) {
    if (!this.isPatientMode) {
      this.startEdit(displayIdx);
      return;
    }
    this.expandedTitleIndex = (this.expandedTitleIndex === displayIdx) ? null : displayIdx;
  }

  /* ---------- Delete video (file + metadata) ---------- */

  async deleteVideo(displayIdx: number) {
    if (this.isPatientMode) return;
    const ri = this.realIndex(displayIdx);
    const item = this.videos[ri];
    if (!item) return;

    const confirm = await this.alertCtrl.create({
      header: 'Delete video?',
      message: 'This will remove the video from your device.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive' },
      ],
      backdropDismiss: true,
    });
    await confirm.present();
    const res = await confirm.onDidDismiss();
    if (res.role !== 'destructive') return;

    try { await Filesystem.deleteFile({ path: item.path, directory: Directory.Data }); } catch {}

    this.videos.splice(ri, 1);
    this.prepareProgress();
    this.rebuildDisplay();

    if (this.expandedTitleIndex === displayIdx) this.expandedTitleIndex = null;

    await this.persistMetadata();
    this.cdr.detectChanges();

    // Keep scroll stable
    setTimeout(() => this.jumpToPage(this.videos.length > 1 ? 1 : 0), 0);
  }

  /* ---------- Video controls ---------- */

  onLoadedMeta(displayIdx: number) {
    const v = this.getVideo(displayIdx);
    if (!v) return;
    const dur = isFinite(v.duration) ? v.duration : 0;
    const ri = this.realIndex(displayIdx);
    this.ensureProgressIndex(ri);
    this.progress[ri].duration = dur > 0 ? dur : 0;
  }

  onTimeUpdate(displayIdx: number) {
    const v = this.getVideo(displayIdx);
    if (!v) return;
    const ri = this.realIndex(displayIdx);
    this.ensureProgressIndex(ri);
    this.progress[ri].current = v.currentTime || 0;
    if (!this.progress[ri].duration && isFinite(v.duration)) {
      this.progress[ri].duration = v.duration || 0;
    }
  }

  onSeek(ev: CustomEvent, displayIdx: number) {
    const value = (ev.detail as any).value ?? 0;
    const v = this.getVideo(displayIdx);
    if (!v) return;
    v.currentTime = Number(value) || 0;
    const ri = this.realIndex(displayIdx);
    this.ensureProgressIndex(ri);
    this.progress[ri].current = v.currentTime;
  }

  onVideoTap(displayIdx: number) {
    const v = this.getVideo(displayIdx);
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  isPlaying(displayIdx: number): boolean {
    const v = this.getVideo(displayIdx);
    return !!v && !v.paused && !v.ended && v.currentTime > 0;
  }

  formatTime(sec: number): string {
    if (!sec || !isFinite(sec)) return '0:00';
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    const m = Math.floor(sec / 60);
    return `${m}:${s}`;
  }

  /* ---------- Storage helpers ---------- */

  private prepareProgress() {
    this.progress = this.videos.map(() => ({ current: 0, duration: 0 }));
  }

  private async persistMetadata() {
    // Videos are now stored in Firebase only, no local persistence needed
    console.log('Videos are stored in Firebase only');
  }

  private async restoreFromStorage() {
    // Videos are now loaded from Firebase subscription, not local storage
    // This method is kept for compatibility but does nothing
    console.log('Videos are now loaded from Firebase only');
  }

  private async saveVideoFile(file: File, label?: string): Promise<VideoView> {
    try {
      console.log('🔥 Starting video upload to Cloudinary...', { fileName: file.name, label });
      
      // Upload video to Cloudinary using Firebase service
      const uploadResult = await this.firebaseService.uploadVideoToCloudinary(file, label);
      
      console.log('🔥 Video uploaded successfully to Cloudinary:', uploadResult);
      
      const createdAt = Date.now();
      const meta: VideoMeta = { 
        id: uploadResult.id, 
        path: '', // No local path since we're using Cloudinary
        label: uploadResult.title, 
        createdAt,
        poster: uploadResult.thumbnailUrl // Use Cloudinary thumbnail as poster
      };

      // Create VideoView with Cloudinary video URL
      const videoView: VideoView = { 
        ...meta, 
        src: uploadResult.videoUrl 
      };

      console.log('🔥 Video metadata created:', videoView);

      // Dispatch same-device realtime event so open views refresh instantly
      window.dispatchEvent(new CustomEvent('video-added', { detail: { meta, src: uploadResult.videoUrl } }));

      return videoView;
    } catch (error) {
      console.error('❌ Failed to upload video to Cloudinary:', error);
      throw new Error('Failed to save video. Please try again.');
    }
  }

  // pathToSrc method removed - videos now use Firebase download URLs directly

  private onVideoAdded = (e: CustomEvent) => {
    try {
      const detail: any = (e as any).detail;
      if (!detail || !detail.meta || !detail.src) { 
        // Fallback to Firebase subscription refresh
        return; 
      }
      const newVid: VideoView = { 
        id: detail.meta.id, 
        path: detail.meta.path, 
        label: detail.meta.label, 
        createdAt: detail.meta.createdAt, 
        poster: detail.meta.poster, 
        src: detail.src 
      };
      // Avoid duplicates
      if (this.videos.some(v => v.id === newVid.id)) return;
      this.videos.unshift(newVid);
      this.displayVideos = this.makeLoopDisplay(this.videos);
      this.progress.unshift({ current: 0, duration: 0 });
      this.cdr.detectChanges();
    } catch (error) {
      console.error('Error handling video added event:', error);
    }
  }

  private videosUnsub?: any;

  private attachVideosSubscription() {
    try {
      this.detachVideosSubscription();
      console.log('🔥 Setting up Firebase video subscription...');
      
      this.videosUnsub = this.firebaseService.subscribeToVideos((items: any[]) => {
        console.log('🔥 Firebase videos received:', items?.length || 0, 'videos');
        
        const firebaseVideos: VideoView[] = (items || []).map((v: any) => ({
          id: v.id,
          path: '', // No local path for Cloudinary videos
          label: v.label,
          createdAt: v.createdAt,
          src: v.downloadURL, // Cloudinary video URL
          poster: v.thumbnailUrl // Cloudinary thumbnail URL
        }));

        console.log('🔥 Processed Firebase videos:', firebaseVideos.length);

        // Replace all videos with Firebase videos (account-specific)
        this.videos = firebaseVideos.sort((a, b) => b.createdAt - a.createdAt);
        this.rebuildDisplay();
        this.prepareProgress();
        this.cdr.detectChanges();
        
        console.log('🔥 Videos updated in UI:', this.videos.length);
      });
    } catch (error) {
      console.error('❌ Failed to subscribe to Firebase videos:', error);
    }
  }
  private detachVideosSubscription() {
    try { if (this.videosUnsub) this.videosUnsub(); } catch {}
    this.videosUnsub = undefined;
  }

  // fileToBase64 method removed - files are uploaded directly to Firebase Storage

  private getVideo(displayIdx: number): HTMLVideoElement | null {
    const ref = this.vidRefs?.get(displayIdx);
    return ref?.nativeElement ?? null;
  }

  private ensureProgressIndex(realIdx: number) {
    if (!this.progress[realIdx]) this.progress[realIdx] = { current: 0, duration: 0 };
  }

  private async promptForName(header: string, value: string): Promise<string | null> {
    const alert = await this.alertCtrl.create({
      header,
      inputs: [{ name: 'label', type: 'text', placeholder: '(optional)', value }],
      buttons: [{ text: 'Skip', role: 'cancel' }, { text: 'Save', role: 'confirm' }],
      backdropDismiss: true,
    });
    await alert.present();
    const { role, data } = await alert.onDidDismiss();
    if (role !== 'confirm') return null;
    return (data?.values?.label ?? '') as string;
  }

  // ===== Gallery functionality =====
  openDetailView(video: VideoView, index: number) {
    this.selectedVideo = video;
    this.selectedVideoIndex = index;
    this.showDetailModal = true;
    this.editLabel = video.label || '';
  }

  closeDetailView() {
    this.showDetailModal = false;
    this.selectedVideo = null;
    this.selectedVideoIndex = -1;
    this.isDetailVideoPlaying = false;
    this.detailVideoCurrent = 0;
    this.detailVideoDuration = 0;
  }

  onDetailVideoLoaded() {
    const video = this.detailVideoRef?.nativeElement;
    if (video) {
      this.detailVideoDuration = video.duration || 0;
    }
  }

  onDetailVideoTimeUpdate() {
    const video = this.detailVideoRef?.nativeElement;
    if (video) {
      this.detailVideoCurrent = video.currentTime || 0;
    }
  }

  toggleDetailVideoPlay() {
    const video = this.detailVideoRef?.nativeElement;
    if (!video) return;

    if (this.isDetailVideoPlaying) {
      video.pause();
      this.isDetailVideoPlaying = false;
    } else {
      video.play().then(() => {
        this.isDetailVideoPlaying = true;
      }).catch(() => {
        this.isDetailVideoPlaying = false;
      });
    }
  }

  onDetailVideoSeek(event: CustomEvent) {
    const video = this.detailVideoRef?.nativeElement;
    if (!video) return;

    const value = Number(event.detail?.value || 0);
    video.currentTime = value;
    this.detailVideoCurrent = value;
  }

  async deleteVideoFromGallery(index: number) {
    if (this.isPatientMode) return;

    const video = this.videos[index];
    if (!video) return;

    const alert = await this.alertCtrl.create({
      header: 'Delete Video',
      message: `Remove "${video.label || 'this video'}" from your memories?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => this.performDeleteVideo(index) }
      ]
    });
    await alert.present();
  }

  private async performDeleteVideo(index: number) {
    try {
      const video = this.videos[index];
      if (!video) return;

      // Delete from Cloudinary and Firestore
      try {
        await this.firebaseService.deleteVideoFromCloudinary(video.id);
        console.log('✅ Video deleted from Cloudinary and Firestore');
        
        // Show success message
        const toast = await this.toastCtrl.create({
          message: 'Video deleted successfully!',
          duration: 2000,
          position: 'bottom'
        });
        await toast.present();
      } catch (firebaseError: any) {
        console.error('Failed to delete video from Cloudinary:', firebaseError);
        const toast = await this.toastCtrl.create({
          message: 'Failed to delete video. Please try again.',
          duration: 3000,
          position: 'bottom',
          color: 'danger'
        });
        await toast.present();
        return; // Don't update UI if deletion failed
      }

      // Close detail view if this was the selected video
      if (this.selectedVideo && this.selectedVideo.id === video.id) {
        this.closeDetailView();
      }

      // Video will be removed from UI via Firebase subscription
      this.cdr.detectChanges();
    } catch (error) {
      console.error('Failed to delete video:', error);
    }
  }

  goBack() {
    this.location.back();
  }

  /* ---------- Video Navigation ---------- */
  goToPreviousVideo() {
    if (this.selectedVideoIndex > 0) {
      const prevIndex = this.selectedVideoIndex - 1;
      this.openDetailView(this.videos[prevIndex], prevIndex);
    }
  }

  goToNextVideo() {
    if (this.selectedVideoIndex < this.videos.length - 1) {
      const nextIndex = this.selectedVideoIndex + 1;
      this.openDetailView(this.videos[nextIndex], nextIndex);
    }
  }

  /* ---------- Format Duration ---------- */
  formatDuration(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  /* ---------- Edit Video ---------- */
  async editVideo(video: any) {
    if (!video) return;
    
    const alert = await this.alertCtrl.create({
      header: 'Edit Title',
      inputs: [
        {
          name: 'label',
          type: 'text',
          placeholder: 'Video title',
          value: video.label || ''
        }
      ],
      buttons: [
        {
          text: 'Done',
          handler: async (data) => {
            try {
              // Update video label
              video.label = data.label;
              
              // Save to local storage
              this.prepareProgress();
              this.rebuildDisplay();
              
              // Update Firebase if video has an ID
              if (video.id) {
                await this.firebaseService.saveVideoMemory({
                  id: video.id,
                  title: data.label,
                  videoURL: video.src,
                  poster: video.poster
                });
              }
              
              await this.toast('Video updated', 'success');
            } catch (err) {
              console.error('Failed to update video:', err);
              await this.toast('Failed to update video', 'danger');
            }
          }
        }
      ]
    });
    await alert.present();
  }

  /* ---------- Delete Video (from detail view) ---------- */
  async deleteVideoFromDetail(video: any) {
    if (!video) return;
    
    const alert = await this.alertCtrl.create({
      header: 'Delete Video',
      message: `Remove "${video.label || 'this video'}"?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: async () => {
            try {
              // Delete from Cloudinary and Firestore
              if (video.id) {
                await this.firebaseService.deleteVideoFromCloudinary(video.id);
                console.log('✅ Video deleted from Cloudinary:', video.id);
              }

              // Close detail view
              this.closeDetailView();

              // Show success message
              const toast = await this.toastCtrl.create({
                message: 'Video deleted successfully!',
                duration: 2000,
                position: 'bottom'
              });
              await toast.present();
            } catch (err) {
              console.error('Failed to delete video:', err);
              const toast = await this.toastCtrl.create({
                message: 'Failed to delete video. Please try again.',
                duration: 3000,
                position: 'bottom',
                color: 'danger'
              });
              await toast.present();
            }
          }
        }
      ]
    });
    await alert.present();
  }

  private async toast(message: string, color: 'success' | 'warning' | 'danger' | 'primary' = 'primary') {
    const t = await this.toastCtrl.create({
      message,
      duration: 2000,
      color,
      position: 'bottom'
    });
    await t.present();
  }
}