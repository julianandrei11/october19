import { Component, ElementRef, OnDestroy, OnInit, ViewChild, ChangeDetectorRef, NgZone } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertController, ToastController, ActionSheetController } from '@ionic/angular';
import { Location } from '@angular/common';
import { FirebaseService } from '../../services/firebase.service';

type UUID = string;

interface UserCategory {
  id: UUID;
  name: string;
  description?: string;
  emoji?: string;
  createdAt: number;
}

interface RawFlashcard {
  id: UUID;
  categoryId: UUID;
  type: 'photo' | 'video' | 'manual';
  src: string;
  label?: string;
  audio?: string | null;
  duration?: number; // seconds
  createdAt: number;
}

interface DisplayCard {
  id: UUID;
  label: string;
  image: string;       // from src
  audio?: string | null;
  duration?: number;   // seconds
}

const CATEGORIES_KEY = 'alala_custom_categories_v1';
const CARDS_PREFIX   = 'alala_cards_';

@Component({
  selector: 'app-custom-category',
  templateUrl: './custom-category.page.html',
  styleUrls: ['./custom-category.page.scss'],
  standalone: false
})
export class CustomCategoryPage implements OnInit, OnDestroy {
  @ViewChild('photoInput') photoInput!: ElementRef<HTMLInputElement>;
  @ViewChild('videoInput') videoInput!: ElementRef<HTMLInputElement>;

  id = '';
  title = 'Category';
  description?: string;
  emoji = '🗂️';

  isPatientMode = localStorage.getItem('patientMode') === 'true';

  // single-flashcard view data
  displayCards: DisplayCard[] = [];
  currentCard: DisplayCard | null = null;
  currentIndex = 0;

  // audio player state
  currentAudio: HTMLAudioElement | null = null;
  isPlaying = false;
  currentTime = 0;
  duration = 0;
  private rafId: number | null = null;

  // Skip tracking
  skipCount = 0;
  skippedCardIds: string[] = [];

  private modeListener = (e: any) => {
    this.isPatientMode = !!e?.detail;
  };

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController,
    private actionSheetCtrl: ActionSheetController,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private location: Location,
    private firebaseService: FirebaseService
  ) {}

  ngOnInit() {
    window.addEventListener('patientMode-changed', this.modeListener);

    // Which category?
    this.id = this.route.snapshot.paramMap.get('id') || '';

    // Prefer fast name via router state
    const state = this.router.getCurrentNavigation()?.extras?.state as { categoryName?: string } | undefined;
    if (state?.categoryName) {
      this.title = state.categoryName;
    }

    // Ensure full info from storage
    const cat = this.findCategoryById(this.id);
    if (cat) {
      this.title = cat.name || this.title;
      this.description = cat.description;
      this.emoji = cat.emoji || this.emoji;
    }

    this.loadDisplayCards();
  }

  ionViewWillEnter() {
    this.loadDisplayCards();
  }

  ngOnDestroy() {
    window.removeEventListener('patientMode-changed', this.modeListener);
    this.stopAudio();
  }

  /* ---------- Storage helpers ---------- */
  private getAllCategories(): UserCategory[] {
    try {
      const user = this.firebaseService.getCurrentUser();
      const userSpecificKey = user ? `${CATEGORIES_KEY}_${user.uid}` : CATEGORIES_KEY;
      const raw = localStorage.getItem(userSpecificKey);
      return raw ? (JSON.parse(raw) as UserCategory[]) : [];
    } catch { return []; }
  }
  private findCategoryById(id: string): UserCategory | undefined {
    return this.getAllCategories().find(c => c.id === id);
  }
  private cardsKey(): string {
    return `${CARDS_PREFIX}${this.id}`;
  }

  private loadDisplayCards() {
    const raw = this.getRawCards();
    // Only use photo cards so UI matches People page
    const photos = raw.filter(c => c.type === 'photo');
    this.displayCards = photos.map(c => ({
      id: c.id,
      label: c.label || 'Untitled',
      image: c.src,
      audio: c.audio || null,
      duration: c.duration || 0
    }));

    console.log('Custom Category loaded cards:', this.displayCards.map(c => ({ 
      label: c.label, 
      hasAudio: !!c.audio, 
      audioSrc: c.audio?.substring(0, 50),
      duration: c.duration 
    })));

    if (this.displayCards.length > 0) {
      this.setCard(Math.min(this.currentIndex, this.displayCards.length - 1));
    } else {
      this.currentCard = null;
      this.stopAudio();
    }
  }

  private getRawCards(): RawFlashcard[] {
    try {
      const raw = localStorage.getItem(this.cardsKey());
      return raw ? (JSON.parse(raw) as RawFlashcard[]) : [];
    } catch { return []; }
  }
  private saveRawCards(list: RawFlashcard[]) {
    localStorage.setItem(this.cardsKey(), JSON.stringify(list));
  }

  /* ---------- Add / Delete ---------- */

  async onDeleteCategory() {
    if (this.isPatientMode) return;
    const alert = await this.alertCtrl.create({
      header: 'Remove Category',
      message: `Remove “${this.title}”? This only removes the category; your media stays in your library.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Remove',
          role: 'destructive',
          handler: () => {
            const list = this.getAllCategories().filter(c => c.id !== this.id);
            const user = this.firebaseService.getCurrentUser();
            const userSpecificKey = user ? `${CATEGORIES_KEY}_${user.uid}` : CATEGORIES_KEY;
            localStorage.setItem(userSpecificKey, JSON.stringify(list));
            window.dispatchEvent(new CustomEvent('categories-updated', { detail: list }));
            this.presentToast('Category removed', 'success');
            this.router.navigate(['/home']);
          }
        }
      ]
    });
    await alert.present();
  }

  async deleteCurrentCard() {
    if (!this.currentCard) return;

    const alert = await this.alertCtrl.create({
      header: 'Delete Memory',
      message: `Remove "${this.currentCard.label || 'this memory'}"?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: async () => {
            try {
              // Delete from Firebase using the card ID and category
              if (this.currentCard?.id) {
                await this.firebaseService.deleteFlashcard(this.currentCard.id, this.id);
              }

              // Update local state
              const raw = this.getRawCards();
              const idxInRaw = raw.findIndex(r => r.id === this.currentCard!.id);
              if (idxInRaw >= 0) {
                raw.splice(idxInRaw, 1);
                this.saveRawCards(raw);
              }

              // Refresh view
              const prevIndex = this.currentIndex;
              this.loadDisplayCards();
              if (this.displayCards.length > 0) {
                this.setCard(Math.min(prevIndex, this.displayCards.length - 1));
              } else {
                this.currentCard = null;
                this.stopAudio();
              }

              // Notify other pages that a card was deleted
              window.dispatchEvent(new CustomEvent('card-deleted', { 
                detail: { cardId: this.currentCard?.id, category: this.id } 
              }));
            } catch (err) {
              console.error('Failed to delete card:', err);
              const errorAlert = await this.alertCtrl.create({
                header: 'Error',
                message: 'Failed to delete memory. Please try again.',
                buttons: ['OK']
              });
              await errorAlert.present();
            }
          }
        }
      ]
    });

    await alert.present();
  }

  async editCurrentCard() {
    if (!this.currentCard) return;

    // Navigate to add-flashcard page with edit mode
    this.router.navigate(['/add-flashcard'], {
      queryParams: {
        defaultCategoryId: this.id,
        editCardId: this.currentCard.id,
        editLabel: this.currentCard.label
      }
    });
  }

  goBack() {
    this.router.navigate(['/memory-categories']);
  }

  /* ---------- Card navigation ---------- */
  setCard(index: number) {
    if (this.displayCards.length === 0) {
      this.currentCard = null;
      this.stopAudio();
      return;
    }
    this.currentIndex = (index + this.displayCards.length) % this.displayCards.length;
    this.currentCard = this.displayCards[this.currentIndex];

    const storedDur = Number(this.currentCard?.duration ?? 0);
    this.buildPlayer(this.currentCard?.audio || null, storedDur);
  }
  nextCard() { this.setCard(this.currentIndex + 1); }
  prevCard() { this.setCard(this.currentIndex - 1); }

  // ===== Skip (recorded) =====
  skipCurrent() {
    if (!this.currentCard) return;
    this.skipCount++;
    if (this.currentCard.id) this.skippedCardIds.push(this.currentCard.id);
    this.nextCard();
  }

  /* ---------- Audio Validation ---------- */
  private isValidAudioSource(src: string): boolean {
    if (!src) return false;
    if (src.startsWith('data:audio/')) return true;
    if (src.startsWith('blob:')) return true;
    if (src.startsWith('http://') || src.startsWith('https://')) return true;
    if (src.startsWith('file://')) return true;
    if (src.includes('capacitor://')) return true;
    console.warn('Unknown audio source format:', src?.substring(0, 50));
    return false;
  }

  /* ---------- Audio ---------- */
  private buildPlayer(src: string | null, storedDuration?: number) {
    this.stopAudio();

    console.log('🔊 Custom Category buildPlayer called with:', { src: src?.substring(0, 50), storedDuration });

    if (!src) {
      this.duration = 0;
      return;
    }

    if (!this.isValidAudioSource(src)) {
      console.warn('Invalid audio source:', src?.substring(0, 50));
      this.duration = 0;
      return;
    }

    this.currentAudio = new Audio(src);
    this.currentAudio.preload = 'metadata';
    this.isPlaying = false;
    this.currentTime = 0;

    // Prefer saved duration
    if (storedDuration && isFinite(storedDuration) && storedDuration > 0) {
      this.duration = storedDuration;
    } else {
      this.duration = 0;
    }

    this.currentAudio.addEventListener('loadedmetadata', () => {
      const metaDur = Number(this.currentAudio?.duration || 0);
      if ((!this.duration || this.duration <= 0) && isFinite(metaDur) && metaDur > 0) {
        this.duration = metaDur;
      }
    });

    this.currentAudio.addEventListener('timeupdate', () => {
      // Round to 2 decimal places to avoid micro-updates causing change detection errors
      const newTime = Math.round((this.currentAudio?.currentTime || 0) * 100) / 100;
      if (Math.abs(newTime - this.currentTime) >= 0.1) {
        this.currentTime = newTime;
        this.cdr.markForCheck();
      }
    });

    this.currentAudio.addEventListener('ended', () => {
      this.isPlaying = false;
      this.stopRaf();
    });

    this.currentAudio.addEventListener('error', (e) => {
      console.error('Audio load error:', e);
      this.isPlaying = false;
      this.stopRaf();
    });
  }

  toggleAudio() {
    console.log('🔊 Custom Category toggleAudio called:', { 
      hasCurrentAudio: !!this.currentAudio, 
      isPlaying: this.isPlaying,
      audioSrc: this.currentAudio?.src?.substring(0, 50)
    });
    
    if (!this.currentAudio) return;
    if (this.isPlaying) {
      this.currentAudio.pause();
      this.isPlaying = false;
      this.stopRaf();
    } else {
      this.currentAudio.play()
        .then(() => {
          this.isPlaying = true;
          this.startRaf();
        })
        .catch(err => {
          console.error('Audio play failed:', err);
          this.isPlaying = false;
          this.stopRaf();
        });
    }
  }

  private startRaf() {
    // Disabled requestAnimationFrame to avoid ExpressionChangedAfterItHasBeenCheckedError
    // The timeupdate event will handle currentTime updates
  }
  private stopRaf() {
    // No longer needed since we're not using requestAnimationFrame
  }

  stopAudio() {
    this.stopRaf();
    if (this.currentAudio) {
      try { this.currentAudio.pause(); } catch {}
      try { this.currentAudio.src = ''; } catch {}
      this.currentAudio = null;
    }
    this.isPlaying = false;
    this.currentTime = 0;
  }

  seekAudio(event: any) {
    if (!this.currentAudio) return;
    const t = Number(event.detail.value ?? 0);
    if (isFinite(t)) {
      this.currentAudio.currentTime = t;
      this.currentTime = Math.round(t * 100) / 100;
      this.cdr.markForCheck();
    }
  }

  formatTime(time: number): string {
    if (!isFinite(time) || isNaN(time) || time < 0) return '0:00';
    const total = Math.floor(time + 0.5);
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
  }

  /* ---------- Toast ---------- */
  private async presentToast(
    message: string,
    color: 'success' | 'warning' | 'danger' | 'primary' = 'primary'
  ) {
    const toast = await this.toastCtrl.create({ message, duration: 1600, color, position: 'bottom' });
    await toast.present();
  }
}
