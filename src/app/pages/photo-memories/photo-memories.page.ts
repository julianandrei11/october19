import { Component, OnDestroy, OnInit, ChangeDetectorRef } from '@angular/core';
import { AlertController, ToastController } from '@ionic/angular';
import { FirebaseService } from '../../services/firebase.service';
import { Location } from '@angular/common';
import type { Unsubscribe } from '@firebase/firestore';

// Built-in categories remain
type BuiltinCategory = 'people' | 'places' | 'objects';
// Allow customs to be tagged distinctly (we don't use this for styling here)
type Category = BuiltinCategory | 'custom' | string;

interface RawCard {
  id?: string;
  label?: string;
  name?: string;
  image?: string;
  photo?: string;
  photoUrl?: string;
  imagePath?: string;
  audio?: string;
  audioUrl?: string;
  audioPath?: string;
  category?: string;
  createdAt?: number | string;
}

// Custom-category stored card shape (from your CustomCategoryPage)
interface RawCustomCard {
  id: string;
  categoryId: string;
  type: 'photo' | 'video' | 'manual';
  src: string;         // image/video url
  label?: string;
  audio?: string | null;
  duration?: number;
  createdAt: number;
}

interface UnifiedCard {
  id: string;
  label: string;
  image: string;
  audio?: string;
  category: Category;
  createdAt?: number;
  // distinguish origin so we can delete/update correctly
  origin: { kind: 'builtin'; key: 'peopleCards' | 'placesCards' | 'objectsCards' }
        | { kind: 'custom'; customId: string }
        | { kind: 'firebase'; id: string };
}

const CATEGORIES_KEY = 'alala_custom_categories_v1';
const CARDS_PREFIX   = 'alala_cards_';

@Component({
  selector: 'app-photo-memories',
  templateUrl: './photo-memories.page.html',
  styleUrls: ['./photo-memories.page.scss'],
  standalone: false
})
export class PhotoMemoriesPage implements OnInit, OnDestroy {
  isPatientMode = false;

  cards: UnifiedCard[] = [];
  idx = -1;

  // Gallery functionality
  showDetailModal = false;
  selectedCard: UnifiedCard | null = null;
  selectedIndex = -1;

  // Audio/timeline
  private audio?: HTMLAudioElement;
  isPlaying = false;
  duration = 0;  // seconds
  current  = 0;  // seconds

   constructor(
    private alertCtrl: AlertController,
    private toastCtrl: ToastController,
    private firebaseService: FirebaseService,
    private cdr: ChangeDetectorRef,
    private location: Location
  ) {}

  private onPatientModeChange = (e?: any) => {
    const v = e?.detail ?? localStorage.getItem('patientMode');
    this.isPatientMode = (v === true || v === 'true');
  };

  ngOnInit(): void {
    this.isPatientMode = localStorage.getItem('patientMode') === 'true';
    this.loadAll();
    console.log(`Photo Memories ngOnInit: loaded ${this.cards.length} cards, isPatientMode=${this.isPatientMode}`);
    if (this.cards.length > 0) this.idx = 0;

    // React to Patient Mode changes app-wide
    window.addEventListener('patientMode-changed', this.onPatientModeChange as any);
    // Live refresh when a flashcard is added anywhere in-app
    window.addEventListener('flashcard-added', this.onFlashcardAdded as any);
    // Cross-device realtime sync via Firestore
    this.attachFlashcardsSubscription();
    window.addEventListener('storage', (ev: StorageEvent) => {
      if (ev.key === 'patientMode') this.onPatientModeChange();
    });
  }

  ionViewWillEnter(): void {
    // Refresh patient mode and data each time we enter
    this.isPatientMode = localStorage.getItem('patientMode') === 'true';
    const prev = this.currentCard?.id;
    this.loadAll();
    if (this.cards.length === 0) { this.idx = -1; this.stopAudio(); return; }
    const keep = prev ? this.cards.findIndex(c => c.id === prev) : -1;
    this.idx = keep >= 0 ? keep : Math.min(Math.max(this.idx, 0), this.cards.length - 1);
  }

  ngOnDestroy(): void {
    this.stopAudio();
    window.removeEventListener('patientMode-changed', this.onPatientModeChange as any);
    window.removeEventListener('flashcard-added', this.onFlashcardAdded as any);
    this.detachFlashcardsSubscription();
  }

  // ===== Derived =====
  get hasCard(): boolean { return this.idx >= 0 && this.idx < this.cards.length; }
  get currentCard(): UnifiedCard | null { return this.hasCard ? this.cards[this.idx] : null; }

  imgSrc(card: UnifiedCard | null): string {
    return card?.image || '';
  }

  // ===== Load & normalize: Builtins + Custom Categories =====
  private loadAll() {
    // Builtins
    const people  = this.readBuiltin('peopleCards',  'people');
    const places  = this.readBuiltin('placesCards',  'places');
    const objects = this.readBuiltin('objectsCards', 'objects');

    // Customs
    const customs = this.readAllCustoms();

    const all = [...people, ...places, ...objects, ...customs];

    // Sort newest first if createdAt exists
    all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    console.log(`loadAll: people=${people.length}, places=${places.length}, objects=${objects.length}, customs=${customs.length}, total=${all.length}`);
    this.cards = all;
  }

  private readBuiltin(key: 'peopleCards' | 'placesCards' | 'objectsCards', cat: BuiltinCategory): UnifiedCard[] {
    const user = this.firebaseService.getCurrentUser();
    const uid = user ? user.uid : 'anon';
    const scopedKey = `${key}_${uid}`;
    const raw = localStorage.getItem(scopedKey);
    console.log(`readBuiltin(${key}): scopedKey=${scopedKey}, raw=${raw ? 'exists' : 'null'}`);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw) as RawCard[];
      console.log(`readBuiltin(${key}): parsed ${arr.length} items`);
      // De-duplicate by label+image within the list
      const seen = new Set<string>();
      const unique = arr.filter((c) => {
        const label = (c.label || c.name || '').toString().trim().toLowerCase();
        const image = (c.image || c.photo || c.photoUrl || c.imagePath || '').toString();
        const key = `${label}::${image}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      const result = unique
        .map((c, i) => this.normalizeBuiltin(c, cat, key, i))
        .filter((x): x is UnifiedCard => !!x && !!x.label && !!x.image);
      console.log(`readBuiltin(${key}): returning ${result.length} cards`);
      return result;
    } catch (e) {
      console.error(`readBuiltin(${key}) error:`, e);
      return [];
    }
  }

  private normalizeBuiltin(
    c: RawCard,
    category: BuiltinCategory,
    originKey: 'peopleCards' | 'placesCards' | 'objectsCards',
    i: number
  ): UnifiedCard | null {
    const id    = (c.id || `${originKey}-${i}-${Date.now()}`).toString();
    const label = (c.label || c.name || '').toString().trim();
    const image = (c.image || c.photo || c.photoUrl || c.imagePath || '').toString().trim();
    const audio = (c.audio || c.audioUrl || c.audioPath || '').toString().trim();
    if (!label || !image) return null;

    let createdAt: number | undefined;
    if (c.createdAt) {
      const n = typeof c.createdAt === 'string' ? Date.parse(c.createdAt) : c.createdAt;
      if (!Number.isNaN(n)) createdAt = typeof n === 'number' ? n : undefined;
    }

    return {
      id,
      label,
      image,
      audio: audio || undefined,
      category,
      createdAt,
      origin: { kind: 'builtin', key: originKey }
    };
    }

  private readAllCustoms(): UnifiedCard[] {
    // 1) Load the list of user categories
    const cats = this.getAllUserCategories();
    if (cats.length === 0) return [];

    // 2) For each, read its cards and keep only photos (to match People-like UI)
    const all: UnifiedCard[] = [];
    for (const c of cats) {
      const rawList = this.readCustomCards(c.id);
      const photos = rawList.filter(it => it.type === 'photo');
      for (const p of photos) {
        const id = p.id;
        const label = (p.label || 'Untitled').toString();
        const image = (p.src || '').toString();
        if (!id || !image) continue;

        // createdAt is already numeric per your writer
        const createdAt = typeof p.createdAt === 'number' ? p.createdAt : Date.now();

        all.push({
          id,
          label,
          image,
          audio: p.audio || undefined,
          category: 'custom',
          createdAt,
          origin: { kind: 'custom', customId: c.id }
        });
      }
    }
    return all;
  }

  private getAllUserCategories(): Array<{ id: string; name: string }> {
    try {
      const user = this.firebaseService.getCurrentUser();
      const userSpecificKey = user ? `${CATEGORIES_KEY}_${user.uid}` : CATEGORIES_KEY;
      const raw = localStorage.getItem(userSpecificKey);
      const arr = raw ? JSON.parse(raw) as Array<{ id: string; name: string }> : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  private readCustomCards(categoryId: string): RawCustomCard[] {
    try {
      const raw = localStorage.getItem(`${CARDS_PREFIX}${categoryId}`);
      return raw ? JSON.parse(raw) as RawCustomCard[] : [];
    } catch { return []; }
  }

  private saveCustomCards(categoryId: string, list: RawCustomCard[]) {
    localStorage.setItem(`${CARDS_PREFIX}${categoryId}`, JSON.stringify(list));
  }

  // Handle realtime insert events by reloading the unified list
  private onFlashcardAdded = (_e: CustomEvent) => {
    // Rely on single-source reload to avoid double insertions
    const prev = this.currentCard?.id;
    this.loadAll();
    if (this.cards.length === 0) { this.idx = -1; return; }
    const keep = prev ? this.cards.findIndex(c => c.id === prev) : -1;
    this.idx = keep >= 0 ? keep : Math.min(Math.max(this.idx, 0), this.cards.length - 1);
  }

  // ===== Firebase realtime (cross-device) =====
  private flashcardsUnsub?: Unsubscribe;
  private attachFlashcardsSubscription() {
    try {
      this.detachFlashcardsSubscription();
      this.flashcardsUnsub = this.firebaseService.subscribeToFlashcards((all) => {
        // Build unified list directly from Firebase flashcards
        const seen = new Set<string>();
        const mapped: UnifiedCard[] = (all || []).map((fc: any, i: number) => {
          const id = fc.id || `fc_${i}`;
          const label = (fc.label || '').toString();
          const image = (fc.src || fc.image || '').toString();
          const audio = (fc.audio || undefined) as string | undefined;
          const createdAt = typeof fc.createdAt === 'number' ? fc.createdAt : Date.now();
          const origin: any = { kind: 'firebase', id: fc.id || id };
          return { id, label, image, audio, category: (fc.category || 'custom') as any, createdAt, origin } as UnifiedCard;
        }).filter(c => !!c.image && !!c.label)
        .filter(c => { const key = `${c.label.toLowerCase()}::${c.image}`; if (seen.has(key)) return false; seen.add(key); return true; });

        console.log(`Firebase subscription: received ${mapped.length} flashcards`);

        // Always sync with Firebase - if Firebase has fewer cards, remove local cards that don't exist in Firebase
        const firebaseIds = new Set(mapped.map(c => c.id));
        
        // If Firebase has data, use it as the source of truth
        if (mapped.length > 0) {
          const prev = this.currentCard?.id;
          this.cards = mapped.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

          // Cache locally for offline support
          this.cacheCardsLocally(this.cards);

          if (this.cards.length === 0) { this.idx = -1; this.stopAudio(); this.cdr.detectChanges(); return; }
          const keep = prev ? this.cards.findIndex(c => c.id === prev) : -1;
          this.idx = keep >= 0 ? keep : Math.min(Math.max(this.idx, 0), this.cards.length - 1);

          console.log(`Photo Memories: Loaded ${mapped.length} flashcards from Firebase`);
          this.cdr.detectChanges();
        } else {
          // Firebase is empty - remove all local cards that don't exist in Firebase
          console.log(`Firebase returned empty, removing all local cards`);
          const prev = this.currentCard?.id;
          this.cards = [];
          this.idx = -1;
          this.stopAudio();
          
          // Clear local storage for all categories
          const user = this.firebaseService.getCurrentUser();
          const uid = user ? user.uid : 'anon';
          const storageKeys = [
            `peopleCards_${uid}`,
            `placesCards_${uid}`,
            `objectsCards_${uid}`
          ];
          
          storageKeys.forEach(key => {
            localStorage.removeItem(key);
            console.log(`Cleared local storage: ${key}`);
          });
          
          this.cdr.detectChanges();
        }
      });
    } catch (e) {
      console.error('Failed to attach flashcards subscription:', e);
    }
  }
  private detachFlashcardsSubscription() {
    try { this.flashcardsUnsub?.(); } catch {}
    this.flashcardsUnsub = undefined;
  }

  private cacheCardsLocally(cards: UnifiedCard[]) {
    try {
      const user = this.firebaseService.getCurrentUser();
      const uid = user ? user.uid : 'anon';
      const cacheKey = `photoMemoriesCache_${uid}`;
      localStorage.setItem(cacheKey, JSON.stringify(cards));
    } catch (e) {
      console.warn('Failed to cache photo memories locally:', e);
    }
  }

  // ===== Navigation =====
  prev() {
    if (!this.hasCard) return;
    this.stopAudio();
    this.idx = (this.idx - 1 + this.cards.length) % this.cards.length;
  }

  next() {
    if (!this.hasCard) return;
    this.stopAudio();
    this.idx = (this.idx + 1) % this.cards.length;
  }

  // ===== Audio + timeline =====
  async togglePlay() {
    const card = this.currentCard;
    if (!card?.audio) { await this.toast('No audio for this memory', 'warning'); return; }

    // Recreate audio when switching cards
    if (!this.audio || this.audio.src !== card.audio) {
      this.stopAudio();
      this.audio = new Audio(card.audio);
      this.audio.preload = 'metadata';
      this.audio.addEventListener('loadedmetadata', () => {
        this.duration = this.audio?.duration ?? 0;
      });
      this.audio.addEventListener('timeupdate', () => {
        this.current = this.audio?.currentTime ?? 0;
      });
      this.audio.addEventListener('ended', () => {
        this.isPlaying = false;
        this.current = 0;
      });
    }

    if (this.isPlaying) {
      this.audio.pause();
      this.isPlaying = false;
    } else {
      try {
        await this.audio.play();
        this.isPlaying = true;
      } catch {
        this.isPlaying = false;
        await this.toast('Unable to play audio', 'danger');
      }
    }
  }

  onSeek(ev: CustomEvent) {
    if (!this.audio) return;
    const val = Number((ev as any).detail?.value || 0);
    this.audio.currentTime = val;
    this.current = val;
  }

  private stopAudio() {
    if (this.audio) {
      try { this.audio.pause(); } catch {}
      try { this.audio.src = ''; } catch {}
      this.audio = undefined;
    }
    this.isPlaying = false;
    this.duration = 0;
    this.current = 0;
  }

  // ===== Delete (supports builtins + custom) =====
  async deleteCurrent() {
    if (this.isPatientMode || !this.currentCard) return;

    const alert = await this.alertCtrl.create({
      header: 'Delete Memory',
      message: `Remove "${this.currentCard.label}" from its category?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => this.performDelete() }
      ]
    });
    await alert.present();
  }

  private async performDelete() {
    const card = this.currentCard;
    if (!card) return;

    try {
      // Prefer Firebase deletion using flashcard document id
      try { await (this as any).firebaseService?.deleteFlashcard(card.id); } catch {}

      // Update in-memory list/index
      this.cards.splice(this.idx, 1);
      if (this.cards.length === 0) {
        this.idx = -1;
        this.stopAudio();
      } else if (this.idx >= this.cards.length) {
        this.idx = 0;
      }

      await this.toast('Memory deleted', 'success');
    } catch {
      await this.toast('Delete failed', 'danger');
    }
  }

  // ===== Gallery functionality =====
  openDetailView(card: UnifiedCard, index: number) {
    this.selectedCard = card;
    this.selectedIndex = index;
    this.showDetailModal = true;
    
    // Set the current card for audio functionality
    this.idx = index;
  }

  closeDetailView() {
    this.showDetailModal = false;
    this.selectedCard = null;
    this.selectedIndex = -1;
    this.stopAudio();
  }

  async deleteCard(card: UnifiedCard) {
    if (this.isPatientMode) return;

    const alert = await this.alertCtrl.create({
      header: 'Delete Memory',
      message: `Remove "${card.label}" from its category?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => this.performDeleteCard(card) }
      ]
    });
    await alert.present();
  }

  private async performDeleteCard(card: UnifiedCard) {
    try {
      // Delete from Firebase using the card ID and category (same as People page)
      if (card.id) {
        await this.firebaseService.deleteFlashcard(card.id, card.category || 'people');
        console.log('Flashcard deleted from Firebase:', card.id);
      }

      // Also delete from all local storage locations (People, Places, Objects)
      const user = this.firebaseService.getCurrentUser();
      const uid = user ? user.uid : 'anon';
      
      const storageKeys = [
        `peopleCards_${uid}`,
        `placesCards_${uid}`,
        `objectsCards_${uid}`
      ];

      for (const storageKey of storageKeys) {
        try {
          const stored = localStorage.getItem(storageKey);
          if (stored) {
            const cards = JSON.parse(stored);
            const updatedCards = cards.filter((c: any) => c.id !== card.id);
            if (updatedCards.length !== cards.length) {
              localStorage.setItem(storageKey, JSON.stringify(updatedCards));
              console.log(`Card removed from ${storageKey}`);
            }
          }
        } catch (e) {
          console.warn(`Failed to clean ${storageKey}:`, e);
        }
      }

      // Update local state (same pattern as People page)
      const cardIndex = this.cards.findIndex(c => c.id === card.id);
      if (cardIndex >= 0) {
        this.cards.splice(cardIndex, 1);
        console.log('Card removed from local array');
      }

      // Update cache
      this.cacheCardsLocally(this.cards);

      // Close detail view if this was the selected card
      if (this.selectedCard && this.selectedCard.id === card.id) {
        this.closeDetailView();
      }

      // Trigger change detection
      this.cdr.detectChanges();

      // Notify other pages that a card was deleted
      window.dispatchEvent(new CustomEvent('card-deleted', { 
        detail: { cardId: card.id, category: card.category } 
      }));

      await this.toast('Photo memory and flashcard deleted', 'success');
    } catch (err) {
      console.error('Failed to delete card:', err);
      const errorAlert = await this.alertCtrl.create({
        header: 'Error',
        message: 'Failed to delete photo memory. Please try again.',
        buttons: ['OK']
      });
      await errorAlert.present();
    }
  }

  // ===== Toast helper =====
  private async toast(message: string, color: 'success' | 'warning' | 'danger' | 'primary' = 'primary') {
    const t = await this.toastCtrl.create({
      message,
      color,
      duration: 1700,
      position: 'bottom'
    });
    await t.present();
  }

  goBack() {
    this.location.back();
  }
}
