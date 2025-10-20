import { Component, OnInit, OnDestroy, ChangeDetectorRef, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController } from '@ionic/angular';
import { FirebaseService } from '../../services/firebase.service';
import { Location } from '@angular/common';
import type { Unsubscribe } from '@firebase/firestore';


interface PlaceCard {
  id?: string;
  label?: string;
  image?: string;
  audio?: string;
  duration?: number; // seconds
}

@Component({
  selector: 'app-places',
  templateUrl: './places.page.html',
  styleUrls: ['./places.page.scss'],
  standalone: false
})
export class PlacesPage implements OnInit, OnDestroy {
  placeCards: PlaceCard[] = [];
  currentCard: PlaceCard | null = null;
  currentIndex = 0;

  isPatientMode = false;

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
    this.placeCards = this.getCards();
    if (this.placeCards.length > 0) this.setCard(0);

    // React to Patient Mode changes from Home
    window.addEventListener('patientMode-changed', this.modeListener);

    // Cross-device realtime: subscribe to flashcards and filter Places
    this.attachFlashcardsSubscription();
  }

  ionViewWillEnter() {
    this.placeCards = this.getCards();
    if (this.placeCards.length === 0) {
      this.currentCard = null;
      this.stopAudio();
    } else if (!this.currentCard) {
      this.setCard(0);
    } else {
      const idx = Math.min(this.currentIndex, this.placeCards.length - 1);
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

  // ===== Data IO (Places only) =====
  private storageKey(): string {
    const user = this.firebaseService.getCurrentUser();
    const uid = user ? user.uid : 'anon';
    return `placesCards_${uid}`;
  }
  private getCards(): PlaceCard[] {
    try { return JSON.parse(localStorage.getItem(this.storageKey()) || '[]'); }
    catch { return []; }
  }
  private saveCards(cards: PlaceCard[]) {
    localStorage.setItem(this.storageKey(), JSON.stringify(cards));
  }

  // legacy handler removed; Firebase subscription is the single source now

  // ===== Card navigation =====
  setCard(index: number) {
    if (this.placeCards.length === 0) {
      this.currentCard = null;
      this.stopAudio();
      return;
    }
    this.currentIndex = (index + this.placeCards.length) % this.placeCards.length;
    this.currentCard = this.placeCards[this.currentIndex];

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
    if (src.startsWith('data:audio/')) return true;
    if (src.startsWith('blob:')) return true;
    if (src.startsWith('http://') || src.startsWith('https://')) return true;
    if (src.startsWith('file://')) return true;
    if (src.includes('capacitor://')) return true;
    console.warn('Unknown audio source format:', src?.substring(0, 50));
    return false;
  }

  // ===== Audio =====
  private buildPlayer(src?: string, storedDuration?: number) {
    this.stopAudio();

    console.log('🔊 Places buildPlayer called with:', { src: src?.substring(0, 50), storedDuration });

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
    console.log('🔊 Places toggleAudio called:', { 
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

  // ===== Add / Delete =====

  async deleteCurrentCard() {
    if (!this.currentCard) return;

    const alert = await this.alertCtrl.create({
      header: 'Delete Place',
      message: `Remove "${this.currentCard.label || 'this place'}"?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: async () => {
            try {
              // Delete from Firebase using the card ID and category
              if (this.currentCard?.id) {
                await this.firebaseService.deleteFlashcard(this.currentCard.id, 'places');
              }

              // Update local state
              const idx = this.currentIndex;
              const list = this.getCards();
              list.splice(idx, 1);
              this.saveCards(list);
              this.placeCards = list;

              if (this.placeCards.length > 0) {
                this.setCard(Math.min(idx, this.placeCards.length - 1));
              } else {
                this.currentCard = null;
                this.stopAudio();
              }

              // Show success confirmation
              const successAlert = await this.alertCtrl.create({
                header: 'Success!',
                message: 'Place deleted successfully!',
                buttons: ['OK']
              });
              await successAlert.present();

              // Notify other pages that a card was deleted
              window.dispatchEvent(new CustomEvent('card-deleted', { 
                detail: { cardId: this.currentCard?.id, category: 'places' } 
              }));
            } catch (err) {
              console.error('Failed to delete card:', err);
              const errorAlert = await this.alertCtrl.create({
                header: 'Error',
                message: 'Failed to delete place. Please try again.',
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
        defaultCategory: 'places',
        editCardId: this.currentCard.id,
        editLabel: this.currentCard.label
      }
    });
  }

  goBack() {
    this.router.navigate(['/memory-categories']);
  }

  // ===== Persist session stats =====
  private persistSessionHistory() {
    try {
      const key = 'placesViewHistory';
      const history: any[] = JSON.parse(localStorage.getItem(key) || '[]');
      history.push({
        endedAt: new Date().toISOString(),
        totalCards: this.placeCards.length,
        skipCount: this.skipCount,
        skippedCardIds: this.skippedCardIds
      });
      localStorage.setItem(key, JSON.stringify(history));
    } catch {}
  }

  private attachFlashcardsSubscription() {
    try {
      this.flashcardsUnsub?.();
      // Use structured + flat merged game subscription for Places category
      this.flashcardsUnsub = (this.firebaseService as any).subscribeToGameFlashcards?.(async (all: any[]) => {
        const places = (all || []).filter((c: any) => (c?.category || '').toLowerCase() === 'places');
        const seen = new Set<string>();
        const mapped = places
          .map((c: any) => ({ id: c.id, label: c.label, image: c.src || c.image, audio: c.audio || undefined, duration: Number(c.duration || 0) }))
          .filter((c: any) => { const key = `${(c.label||'').toLowerCase()}::${c.image||''}`; if (seen.has(key)) return false; seen.add(key); return true; });
        
        console.log('📍 Places loaded cards:', mapped.map(c => ({ 
          label: c.label, 
          hasAudio: !!c.audio, 
          audioSrc: c.audio?.substring(0, 50),
          duration: c.duration 
        })));
        
        // Update local storage for offline support
        this.saveCards(mapped);
        
        this.placeCards = mapped;
        if (this.placeCards.length > 0 && !this.currentCard) this.setCard(0);
        
        console.log(`📍 Places page: Loaded ${mapped.length} places flashcards from Firebase`);
      });
    } catch (e) {
      console.error('Failed to attach flashcards subscription:', e);
    }
  }
}
