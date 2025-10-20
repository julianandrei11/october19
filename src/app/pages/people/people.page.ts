import { Component, OnInit, OnDestroy, ChangeDetectorRef, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController } from '@ionic/angular';
import { FirebaseService } from '../../services/firebase.service';
import { Location } from '@angular/common';
import type { Unsubscribe } from '@firebase/firestore';

interface PeopleCard {
  id?: string;
  label?: string;
  image?: string;
  audio?: string;
  duration?: number; // seconds, optional (saved from add page)
}

@Component({
  selector: 'app-people',
  templateUrl: './people.page.html',
  styleUrls: ['./people.page.scss'],
  standalone: false
})
export class PeoplePage implements OnInit, OnDestroy {
  peopleCards: PeopleCard[] = [];
  currentCard: PeopleCard | null = null;
  currentIndex = 0;

  isPatientMode = false;

  currentAudio: HTMLAudioElement | null = null;
  isPlaying = false;

  currentTime = 0;
  duration = 0; // seconds
  private rafId: number | null = null;

  // Skip tracking
  skipCount = 0;
  skippedCardIds: string[] = [];

  private modeListener = (e: any) => {
    this.isPatientMode = !!e?.detail;
  };

  private flashcardsUnsub?: Unsubscribe;

  constructor(
    private router: Router, 
    private alertCtrl: AlertController, 
    private firebaseService: FirebaseService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private location: Location
  ) {}

  ngOnInit() {
    this.loadPatientMode();
    this.peopleCards = this.getCards();
    if (this.peopleCards.length > 0) this.setCard(0);

    // Cross-device realtime: subscribe to user's flashcards and filter People
    this.attachFlashcardsSubscription();

    // React to Patient Mode changes from Home
    window.addEventListener('patientMode-changed', this.modeListener);
    
    // Listen for user login events to refresh data
    window.addEventListener('user-logged-in', (e: any) => {
      console.log('People page: User logged in event received', e.detail);
      this.peopleCards = this.getCards();
      if (this.peopleCards.length > 0) this.setCard(0);
      this.attachFlashcardsSubscription();
    });
  }

  // Refresh when returning from Add page
  ionViewWillEnter() {
    this.peopleCards = this.getCards();
    if (this.peopleCards.length === 0) {
      this.currentCard = null;
      this.stopAudio();
    } else if (!this.currentCard) {
      this.setCard(0);
    } else {
      // Ensure index still valid
      const idx = Math.min(this.currentIndex, this.peopleCards.length - 1);
      this.setCard(idx);
    }
  }

  ngOnDestroy() {
    window.removeEventListener('patientMode-changed', this.modeListener);
    try { this.flashcardsUnsub?.(); } catch {}
    this.stopAudio();
    this.persistSessionHistory();
  }

  // ===== Patient mode =====
  private loadPatientMode() {
    try {
      this.isPatientMode = localStorage.getItem('patientMode') === 'true';
    } catch { this.isPatientMode = false; }
  }

  // ===== Data IO =====
  private storageKey(): string {
    const user = this.firebaseService.getCurrentUser();
    const uid = user ? user.uid : 'anon';
    return `peopleCards_${uid}`;
  }
  private getCards(): PeopleCard[] {
    try { return JSON.parse(localStorage.getItem(this.storageKey()) || '[]'); }
    catch { return []; }
  }
  private saveCards(cards: PeopleCard[]) {
    localStorage.setItem(this.storageKey(), JSON.stringify(cards));
  }

  private attachFlashcardsSubscription() {
    try {
      this.flashcardsUnsub?.();
      // Use structured game flashcards subscription (merges structured + flat paths)
      this.flashcardsUnsub = (this.firebaseService as any).subscribeToGameFlashcards?.(async (all: any[]) => {
        // Filter for builtin People category
        const people = (all || []).filter((c: any) => (c?.category || '').toLowerCase() === 'people');
        // Map to local shape and de-duplicate by label+image
        const seen = new Set<string>();
        const mapped = people
          .map((c: any) => ({
            id: c.id,
            label: c.label,
            image: c.src || c.image,
            audio: c.audio || undefined,
            duration: Number(c.duration || 0)
          }))
          .filter((c: any) => {
            const key = `${(c.label||'').toLowerCase()}::${c.image||''}`;
            if (seen.has(key)) return false; seen.add(key); return true;
          });
        
        // Newest first (createdAt sorting is already applied upstream, but enforce here)
        // Update local storage for offline support
        this.saveCards(mapped);
        
        this.peopleCards = mapped;
        if (this.peopleCards.length > 0 && !this.currentCard) this.setCard(0);
        
        console.log(`👥 People page: Loaded ${mapped.length} people flashcards from Firebase`);
      });
    } catch (e) {
      console.error('Failed to attach flashcards subscription:', e);
    }
  }

  // legacy handler removed; Firebase subscription is the single source now

  // ===== Card navigation =====
  setCard(index: number) {
    if (this.peopleCards.length === 0) {
      this.currentCard = null;
      this.stopAudio();
      return;
    }
    this.currentIndex = (index + this.peopleCards.length) % this.peopleCards.length;
    this.currentCard = this.peopleCards[this.currentIndex];

    const storedDur = Number(this.currentCard?.duration ?? 0);
    this.buildPlayer(this.currentCard?.audio, storedDur);
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

  // ===== Audio Validation =====
  private isValidAudioSource(src: string): boolean {
    if (!src) return false;

    // Check if it's a data URL
    if (src.startsWith('data:audio/')) return true;

    // Check if it's a blob URL
    if (src.startsWith('blob:')) return true;

    // Check if it's an http/https URL
    if (src.startsWith('http://') || src.startsWith('https://')) return true;

    // Check if it's a file:// URL (local device path)
    if (src.startsWith('file://')) return true;

    // Check if it's a capacitor file URL
    if (src.includes('capacitor://')) return true;

    console.warn('Unknown audio source format:', src?.substring(0, 50));
    return false;
  }

  // ===== Audio =====
  private buildPlayer(src?: string, storedDuration?: number) {
    this.stopAudio();

    if (!src) {
      this.duration = 0;
      return;
    }

    // Validate audio source
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

    // Fallback to metadata duration
    this.currentAudio.addEventListener('loadedmetadata', () => {
      const metaDur = Number(this.currentAudio?.duration || 0);
      if ((!this.duration || this.duration <= 0) && isFinite(metaDur) && metaDur > 0) {
        this.duration = metaDur;
      }
    });

    // Handle audio errors
    this.currentAudio.addEventListener('error', (e) => {
      console.error('Audio load error:', e);
      this.isPlaying = false;
      this.stopRaf();
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
  }

  toggleAudio() {
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

  // ===== Add / Delete =====
  // Navigate instead of modal

  async deleteCurrentCard() {
  if (!this.currentCard) return;

  const alert = await this.alertCtrl.create({
    header: 'Delete Person',
    message: `Remove “${this.currentCard.label || 'this person'}”?`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: async () => {
          try {
            // Delete from Firebase using the card ID and category
            if (this.currentCard?.id) {
              await this.firebaseService.deleteFlashcard(this.currentCard.id, 'people');
            }

            // Update local state
            const idx = this.currentIndex;
            const list = this.getCards();
            list.splice(idx, 1);
            this.saveCards(list);
            this.peopleCards = list;

            if (this.peopleCards.length > 0) {
              this.setCard(Math.min(idx, this.peopleCards.length - 1));
            } else {
              this.currentCard = null;
              this.stopAudio();
            }

            // Show success confirmation
            const successAlert = await this.alertCtrl.create({
              header: 'Success!',
              message: 'Person deleted successfully!',
              buttons: ['OK']
            });
            await successAlert.present();
          } catch (err) {
            console.error('Failed to delete card:', err);
            const errorAlert = await this.alertCtrl.create({
              header: 'Error',
              message: 'Failed to delete person. Please try again.',
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
        defaultCategory: 'people',
        editCardId: this.currentCard.id,
        editLabel: this.currentCard.label
      }
    });
  }

  // ===== Persist session stats =====
  private persistSessionHistory() {
    try {
      const key = 'peopleViewHistory';
      const history: any[] = JSON.parse(localStorage.getItem(key) || '[]');
      history.push({
        endedAt: new Date().toISOString(),
        totalCards: this.peopleCards.length,
        skipCount: this.skipCount,
        skippedCardIds: this.skippedCardIds
      });
      localStorage.setItem(key, JSON.stringify(history));
    } catch {}
  }

  goBack() {
    this.router.navigate(['/memory-categories']);
  }
}

/* Simple ID helper (kept in case you reuse) */
function cryptoRandomId() {
  if ('randomUUID' in crypto) return (crypto as any).randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
