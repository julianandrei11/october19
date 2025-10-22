// src/app/services/firebase.service.ts
import { Injectable, inject, runInInjectionContext, Injector } from '@angular/core';
import { Auth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, User, PhoneAuthProvider, linkWithCredential, RecaptchaVerifier, updateProfile } from '@angular/fire/auth';
import { Firestore, doc, setDoc, getDoc, addDoc, collection, query, where, orderBy, limit, getDocs, updateDoc, deleteDoc, writeBatch } from '@angular/fire/firestore';
import { onSnapshot, Unsubscribe } from '@firebase/firestore';
import { Storage, ref, uploadBytes, getDownloadURL, deleteObject } from '@angular/fire/storage';
import { CloudinaryService } from './cloudinary.service';

// Database structure interfaces
interface UserData {
  email: string;
  createdAt: string;
  name?: string;
  photo?: string;
  lastLoginAt?: string;
  role?: 'patient' | 'caregiver' | 'standard';
  securityCode?: string;
  patientInfo?: {
    name: string;
    age?: number;
    gender?: string;
    condition?: string;
    dateOfBirth?: string;
    medicalId?: string;
    notes?: string;
  };
  caregiverInfo?: {
    name: string;
    relationship?: string;
    contactEmail?: string;
    contactPhone?: string;
    notes?: string;
  };
}

interface UserProgress {
  // Time-based breakdown structure
  accuracyOverTime: {
    allTime: number;
    month: number;
    today: number;
    week: number;
  };
  avgTimePerCard: {
    allTime: number;
    month: number;
    today: number;
    week: number;
  };
  cardsReviewed: {
    allTime: number;
    month: number;
    today: number;
    week: number;
  };
  cardsSkipped: {
    allTime: number;
    month: number;
    today: number;
    week: number;
  };
  // Overall stats (all time)
  overallStats: {
    accuracy: number;
    avgTimePerCard: number;
    totalCards: number;
    skippedCards: number;
  };
}

interface GameSession {
  category: string;
  correctAnswers: number;
  totalQuestions: number;
  totalTime: number;
  skipped: number;
  timestamp: string;
}

interface CategoryRecord {
  category: string;
  allTime: {
    accuracy: number;
    avgTimePerCard: number;
    cardsReviewed: number;
    cardsSkipped: number;
  };
  month: {
    accuracy: number;
    avgTimePerCard: number;
    cardsReviewed: number;
    cardsSkipped: number;
  };
  today: {
    accuracy: number;
    avgTimePerCard: number;
    cardsReviewed: number;
    cardsSkipped: number;
  };
  week: {
    accuracy: number;
    avgTimePerCard: number;
    cardsReviewed: number;
    cardsSkipped: number;
  };
  lastUpdated: string;
}

interface UserCategory {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  createdAt: number;
  userId: string;
}

interface UserCard {
  id: string;
  categoryId: string;
  userId: string;
  type: 'photo' | 'video' | 'manual';
  src: string;
  label?: string;
  audio?: string | null;
  duration?: number;
  createdAt: number;
}

interface TrustedContact {
  id: string;
  patientUserId: string;
  caregiverUserId: string;
  patientName?: string;
  caregiverName?: string;
  patientEmail?: string;
  caregiverEmail?: string;
  createdAt: string;
  createdBy: string;
}

@Injectable({
  providedIn: 'root'
})
export class FirebaseService {
  private auth = inject(Auth);
  private firestore = inject(Firestore);
  private storage = inject(Storage);
  private injector = inject(Injector);
  private cloudinaryService = inject(CloudinaryService);

  constructor() {
    console.log('Firebase service initialized successfully');
  }

  async login(email: string, password: string): Promise<User> {
    const userCredential = await signInWithEmailAndPassword(this.auth, email, password);
    return userCredential.user;
  }

  async signup(
    email: string,
    password: string,
    name?: string,
    phoneNumber?: string,
    patientInfo?: {
      name: string;
      age?: number;
      gender?: string;
      condition?: string;
      dateOfBirth?: string;
      medicalId?: string;
      notes?: string;
    },
    caregiverInfo?: {
      name: string;
      relationship?: string;
      contactEmail?: string;
      contactPhone?: string;
      notes?: string;
    }
  ): Promise<User> {
    // Validate required fields
    if (!email || typeof email !== 'string') {
      throw new Error('Valid email is required');
    }
    if (!password || typeof password !== 'string') {
      throw new Error('Valid password is required');
    }
    if (!name || typeof name !== 'string') {
      throw new Error('Valid name is required');
    }
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      throw new Error('Valid phone number is required');
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      throw new Error('Invalid email format');
    }

    // Validate phone number (at least 10 digits)
    const phoneDigitsOnly = phoneNumber.replace(/\D/g, '');
    if (phoneDigitsOnly.length < 10) {
      throw new Error('Phone number must have at least 10 digits');
    }

    // Validate name is not just whitespace
    if (name.trim().length === 0) {
      throw new Error('Name cannot be empty');
    }

    let userCredential;
    try {
      userCredential = await createUserWithEmailAndPassword(this.auth, email, password);
    } catch (error: any) {
      // If auth creation fails, throw immediately
      throw error;
    }

    const uid = userCredential.user.uid;

    try {
      // Generate a unique security code for this account
      const securityCode = await this.generateUniqueSecurityCode();

      // Create user document with profile data (no default data for games/videos/flashcards)
      const userData: UserData = {
        email: email.trim(),
        createdAt: new Date().toISOString(),
        name: name.trim(),
        role: 'standard',
        securityCode,
        // Store provided profiles; avoid undefined writes
        patientInfo: patientInfo ? this.sanitizeForFirestore(patientInfo) as any : undefined,
        caregiverInfo: caregiverInfo ? this.sanitizeForFirestore(caregiverInfo) as any : undefined
      };

      await setDoc(doc(this.firestore, 'users', uid), this.sanitizeForFirestore({ ...userData, phoneNumber: phoneNumber.trim() }));

      // Optionally set displayName on Auth profile
      try { await updateProfile(userCredential.user, { displayName: name.trim() }); } catch {}

      // Initialize zeroed progress document so Progress Page shows 0s by default
      await this.initializeUserProgress(uid);

      return userCredential.user;
    } catch (firestoreError: any) {
      // If Firestore write fails, delete the Auth user to maintain consistency
      console.error('Firestore write failed during signup, rolling back Auth user:', firestoreError);
      try {
        await userCredential.user.delete();
        console.log('Auth user deleted due to Firestore failure');
      } catch (deleteError) {
        console.error('Failed to delete Auth user after Firestore error:', deleteError);
      }
      // Re-throw the original Firestore error
      throw firestoreError;
    }
  }

  /** Begin phone OTP (requires platform-specific reCAPTCHA in web). Returns verificationId. */
  async startPhoneOTP(phoneNumber: string, containerId = 'recaptcha-container'): Promise<string> {
    const auth = this.auth as any;
    const mod = await import('@angular/fire/auth');
    // Create or reuse invisible reCAPTCHA
    const verifier = new mod.RecaptchaVerifier(auth, containerId, { size: 'invisible' }) as RecaptchaVerifier;
    const confirmation = await mod.signInWithPhoneNumber(auth, phoneNumber, verifier as any);
    return confirmation.verificationId;
  }

  /** Verify phone OTP and link to current user */
  async verifyPhoneOTP(verificationId: string, code: string): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    const cred = PhoneAuthProvider.credential(verificationId, code);
    await linkWithCredential(user, cred as any);
    // Persist phone on profile doc
    try {
      const phoneNumber = (user.phoneNumber || null) as any;
      await updateDoc(doc(this.firestore, 'users', user.uid), this.sanitizeForFirestore({ phoneNumber }));
    } catch {}
  }

  /** Save or update patient details under users/{uid}/patientInfo subcollection */
  async savePatientDetails(details: { name: string; age?: number; sex?: string; relationship?: string; notes?: string; emergencyContact?: string }): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // Save to patientInfo subcollection under the user document
    const patientDetailsRef = doc(this.firestore, 'users', user.uid, 'patientInfo', user.uid);
    await setDoc(patientDetailsRef, {
      name: details.name,
      age: details.age || null,
      sex: details.sex || null,
      relationship: details.relationship || null,
      notes: details.notes || null,
      emergencyContact: details.emergencyContact || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, { merge: true });
  }

  /** Save or update additional user details */
  async saveAdditionalUserDetails(details: { fullName?: string; phoneNumber?: string; address?: string; secondaryEmail?: string; notes?: string; preferredLanguage?: string }): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    await setDoc(doc(this.firestore, 'users', user.uid), this.sanitizeForFirestore({ additional: details, phoneNumber: details.phoneNumber || undefined }), { merge: true });
  }

  /**
   * Create a flashcard under users/{uid}/userFlashcards/{category}/cards/{cardId} and auto-create activity entries.
   * Supports built-in categories (people/places/objects) and custom categories via categoryId.
   * Only allowed for caregivers/standard (not patient mode).
   */
  async createFlashcard(
    card: Omit<UserCard, 'id' | 'userId' | 'createdAt'> &
      { type: 'photo' | 'video' | 'manual'; category?: 'people' | 'places' | 'objects' | 'custom-category' | 'photo-memories'; categoryId?: string }
  ): Promise<string> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // role check (patient cannot create)
    const profile = await this.getUserProfile(user.uid);
    if (profile?.role === 'patient') {
      throw new Error('Patients cannot create content');
    }

    const cardId = `card_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const data: any = this.sanitizeForFirestore({
      id: cardId,
      userId: user.uid,
      createdAt: Date.now(),
      ...card
    });

    // Determine structured path under userFlashcards
    const builtinCategory = (card as any).category as string | undefined;
    const customCategoryId = (card as any).categoryId as string | undefined;

    if (builtinCategory && ['people','places','objects','custom-category','photo-memories'].includes(builtinCategory)) {
      await setDoc(doc(this.firestore, 'users', user.uid, 'userFlashcards', builtinCategory, 'cards', cardId), data);
    } else if (customCategoryId) {
      // Store custom-category cards under userFlashcards/custom-category/cards/{id} with categoryId inside the doc
      await setDoc(doc(this.firestore, 'users', user.uid, 'userFlashcards', 'custom-category', 'cards', cardId), this.sanitizeForFirestore({ ...data, categoryId: customCategoryId }));
    } else {
      // Fallback: default to photo-memories bucket if no category provided
      await setDoc(doc(this.firestore, 'users', user.uid, 'userFlashcards', 'photo-memories', 'cards', cardId), data);
    }

    // Auto-create activity entries for games referencing this card
    const activities = [
      { id: `nameThatMemory_${cardId}`, type: 'nameThatMemory', cardId },
      { id: `categoryMatch_${cardId}`, type: 'categoryMatch', cardId }
    ];

    for (const a of activities) {
      const activityDoc = doc(this.firestore, 'users', user.uid, 'activities', a.id);
      await setDoc(activityDoc, this.sanitizeForFirestore({
        id: a.id,
        type: a.type,
        cardId: a.cardId,
        createdAt: Date.now()
      }));
    }

    // Cache locally for offline support
    try {
      const cachedKey = `cachedGameFlashcards_${user.uid}`;
      const cached = JSON.parse(localStorage.getItem(cachedKey) || '[]');
      const newCard = {
        id: cardId,
        label: card.label,
        image: card.src || (card as any).image,
        category: builtinCategory || (customCategoryId ? 'custom-category' : 'photo-memories'),
        createdAt: Date.now()
      };
      cached.unshift(newCard);
      localStorage.setItem(cachedKey, JSON.stringify(cached));
    } catch (e) {
      console.warn('Failed to cache flashcard locally:', e);
    }

    return cardId;
  }

  /**
   * Realtime subscription to all user's flashcards aggregated from structured userFlashcards/<bucket>/cards.
   * Maintains backwards compatibility with views expecting a flat list.
   */
  subscribeToFlashcards(onChange: (cards: any[]) => void): Unsubscribe {
    const uid = this.getCurrentUser()?.uid || localStorage.getItem('userId') || '';
    if (!uid) throw new Error('User not authenticated');
    const categories = ['people','places','objects','custom-category','photo-memories'];
    const unsubs: Unsubscribe[] = [];
    const latest: Record<string, any[]> = {};
    const emit = () => {
      const merged = Object.values(latest).flat();
      // Map to flat structure similar to legacy
      const mapped = merged.map((d: any) => ({
        id: d.id,
        label: d.label,
        src: d.src || d.image,
        image: d.image || d.src,
        audio: d.audio,
        category: (d.category || d._bucket || '').toString(),
        createdAt: d.createdAt || Date.now(),
      }));
      // de-dup by label+image
      const seen = new Set<string>();
      const unique = mapped.filter(c => { const k = `${(c.label||'').toLowerCase()}::${c.src||''}`; if (seen.has(k)) return false; seen.add(k); return true; });
      unique.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      onChange(unique);
    };
    for (const cat of categories) {
      const qy = query(collection(this.firestore, 'users', uid, 'userFlashcards', cat, 'cards'), orderBy('createdAt', 'desc'));
      const u = onSnapshot(qy, (snap) => {
        latest[cat] = snap.docs.map(d => ({ _bucket: cat, ...(d.data() as any) }));
        emit();
      });
      unsubs.push(u);
    }
    return () => { unsubs.forEach(u => { try { u(); } catch {} }); };
  }

  /** Subscribe to structured game flashcards across People/Places/Objects (from userFlashcards only) */
  subscribeToGameFlashcards(onChange: (cards: Array<{ id: string; label: string; image: string; category: string; audio?: string; duration?: number; createdAt?: number }>) => void): Unsubscribe {
    let uid = this.getCurrentUser()?.uid || localStorage.getItem('userId') || '';
    if (!uid) { console.warn('subscribeToGameFlashcards: no UID available yet; will no-op.'); return () => {}; }
    const cats: Array<'people' | 'places' | 'objects'> = ['people','places','objects'];
    const unsubs: Unsubscribe[] = [];
    const latest: Record<string, any[]> = {};
    const emit = () => {
      const merged = Object.values(latest).flat().map((d: any) => ({ id: d.id, label: d.label, image: d.src || d.image, audio: d.audio || undefined, duration: d.duration || 0, category: (d.category || '').toString(), createdAt: d.createdAt }))
        .filter((c: any) => !!c.label && !!c.image);
      const seen = new Set<string>();
      const unique = merged.filter((c: any) => { const k = `${c.category}::${c.label.toLowerCase()}::${c.image}`; if (seen.has(k)) return false; seen.add(k); return true; });
      unique.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      try { localStorage.setItem('cachedGameFlashcards', JSON.stringify(unique)); } catch {}
      onChange(unique as any);
    };
    for (const cat of cats) {
      const qStructured = query(collection(this.firestore, 'users', uid, 'userFlashcards', cat, 'cards'), orderBy('createdAt', 'desc'));
      const u1 = onSnapshot(qStructured, (snap) => {
        latest[cat] = snap.docs.map(d => d.data());
        emit();
      }, (err) => { console.warn('structured snapshot error', err); });
      unsubs.push(u1);
    }
    return () => { unsubs.forEach(u => { try { u(); } catch {} }); };
  }

  /** One-time fetch of game flashcards from structured paths */
  async getGameFlashcardsOnce(): Promise<Array<{ id: string; label: string; image: string; category: string; audio?: string; duration?: number; createdAt?: number }>> {
    const uid = this.getCurrentUser()?.uid || localStorage.getItem('userId') || '';
    if (!uid) return [];
    const out: any[] = [];
    const cats: Array<'people' | 'places' | 'objects'> = ['people','places','objects'];
    for (const cat of cats) {
      try {
        const structured = await getDocs(query(collection(this.firestore, 'users', uid, 'userFlashcards', cat, 'cards'), orderBy('createdAt', 'desc')));
        structured.docs.forEach(d => out.push({ ...(d.data() as any), category: cat }));
      } catch (e) {
        console.warn('getGameFlashcardsOnce structured read error for', cat, e);
      }
    }
    const mapped = out
      .map((d: any) => ({ id: d.id, label: d.label, image: d.src || d.image, audio: d.audio || undefined, duration: d.duration || 0, category: (d.category || '').toString(), createdAt: d.createdAt }))
      .filter((c: any) => !!c.label && !!c.image);
    const seen = new Set<string>();
    const unique = mapped.filter((c: any) => { const k = `${c.category}::${c.label.toLowerCase()}::${c.image}`; if (seen.has(k)) return false; seen.add(k); return true; });
    unique.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (unique.length === 0) {
      // offline/cached fallback
      try {
        const cached = localStorage.getItem('cachedGameFlashcards');
        if (cached) return JSON.parse(cached);
      } catch {}
    }
    return unique as any;
  }

  getCachedGameFlashcards(): Array<{ id: string; label: string; image: string; category: string; createdAt?: number }> {
    try {
      const raw = localStorage.getItem('cachedGameFlashcards');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  // Deprecated migration helper removed: flat 'flashcards' no longer used

  /**
   * Append a progress entry under users/{uid}/activities/{activityId}/progress
   */
  async addActivityProgress(activityId: string, progress: { correct: number; total: number; durationSec?: number; timestamp?: number }): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const p = this.sanitizeForFirestore({
      correct: Number(progress.correct) || 0,
      total: Number(progress.total) || 0,
      durationSec: progress.durationSec ?? null,
      timestamp: progress.timestamp ?? Date.now(),
      accuracy: (Number(progress.total) > 0) ? Number(progress.correct) / Number(progress.total) : 0
    });

    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    await setDoc(doc(this.firestore, 'users', user.uid, 'activities', activityId, 'progress', id), p);
  }

  /** Prevent undefined from being written to Firestore (convert to null or remove) */
  private sanitizeForFirestore<T extends Record<string, any>>(obj: T): T {
    const out: any = {};
    Object.keys(obj || {}).forEach(k => {
      const v = (obj as any)[k];
      if (v === undefined) return; // skip undefined entries
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = this.sanitizeForFirestore(v);
      } else {
        out[k] = v === undefined ? null : v;
      }
    });
    return out;
  }

  private async generateUniqueSecurityCode(): Promise<string> {
    // 8-character uppercase alphanumeric code (e.g., 4G8K2MPL)
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const length = 8;
    const generate = () => Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

    // Ensure uniqueness across all users by querying the users collection
    while (true) {
      const candidate = generate();
      const q = query(collection(this.firestore, 'users'), where('securityCode', '==', candidate));
      const snap = await getDocs(q);
      if (snap.empty) return candidate;
      // else loop and try again
    }
  }

  async logout(): Promise<void> {
    // Clear any local caches that could leak between accounts
    try {
      const lastUid = localStorage.getItem('userId');
      localStorage.removeItem('gameSessions'); // legacy key
      if (lastUid) localStorage.removeItem(`gameSessions:${lastUid}`);
      ['peopleCards','placesCards','objectsCards'].forEach(k => localStorage.removeItem(k));
    } catch {}

    await signOut(this.auth);
  }

  getCurrentUser(): User | null {
    return this.auth.currentUser;
  }

  /** Send password reset email */
  async sendPasswordReset(email: string): Promise<void> {
    const auth = this.auth;
    // dynamic import to avoid tree issues
    const mod = await import('@angular/fire/auth');
    await mod.sendPasswordResetEmail(auth as any, email);
  }

  async getUserData(uid: string) {
    const docRef = doc(this.firestore, 'users', uid);
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? docSnap.data() : null;
  }

  // ===== PATIENT & CAREGIVER PROFILE MANAGEMENT =====

  /**
   * Update user role and profile information
   */
  async updateUserProfile(profileData: {
    role?: 'patient' | 'caregiver' | 'standard';
    patientInfo?: {
      name: string;
      dateOfBirth?: string;
      medicalId?: string;
      notes?: string;
    };
    caregiverInfo?: {
      name: string;
      relationship?: string;
      contactPhone?: string;
      notes?: string;
    };
  }): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const updates: Partial<UserData> = {
      ...profileData,
      lastLoginAt: new Date().toISOString()
    };

    await updateDoc(doc(this.firestore, 'users', user.uid), updates);
  }

  /**
   * Get user profile with role-specific information
   */
  async getUserProfile(uid?: string): Promise<UserData | null> {
    const user = this.getCurrentUser();
    const targetUid = uid || user?.uid;

    if (!targetUid) throw new Error('User not authenticated');

    const docRef = doc(this.firestore, 'users', targetUid);
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? docSnap.data() as UserData : null;
  }

  /**
   * Set user as patient with patient information
   */
  async setAsPatient(patientInfo: {
    name: string;
    dateOfBirth?: string;
    medicalId?: string;
    notes?: string;
  }): Promise<void> {
    await this.updateUserProfile({
      role: 'patient',
      patientInfo
    });
  }

  /**
   * Set user as caregiver with caregiver information
   */
  async setAsCaregiver(caregiverInfo: {
    name: string;
    relationship?: string;
    contactPhone?: string;
    notes?: string;
  }): Promise<void> {
    await this.updateUserProfile({
      role: 'caregiver',
      caregiverInfo
    });
  }

  /**
   * Set user as standard user (no special role)
   */
  async setAsStandard(): Promise<void> {
    await this.updateUserProfile({
      role: 'standard'
    });
  }

  // Progress tracking methods
  async saveGameSession(sessionData: Omit<GameSession, 'timestamp'>): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const gameSession: GameSession = {
      ...sessionData,
      timestamp: new Date().toISOString()
    };

    // Save to users/{uid}/userProgress/stats/gameRecords/{sessionId}
    await addDoc(
      collection(this.firestore, 'users', user.uid, 'userProgress', 'stats', 'gameRecords'),
      gameSession
    );

    // Also save to recentSessions collection
    await this.saveRecentSession(gameSession);

    // Also save to localStorage for offline support
    try {
      const localKey = `gameRecords_${user.uid}`;
      const localSessions = JSON.parse(localStorage.getItem(localKey) || '[]');
      localSessions.push(gameSession);
      localStorage.setItem(localKey, JSON.stringify(localSessions));
    } catch (e) {
      console.warn('Failed to cache game session locally:', e);
    }
  }

  async getUserGameSessions(userId?: string, limitCount?: number): Promise<GameSession[]> {
    const user = this.getCurrentUser();
    const targetUserId = userId || user?.uid;

    if (!targetUserId) throw new Error('User not authenticated');

    let q;
    if (limitCount) {
      q = query(
        collection(this.firestore, 'users', targetUserId, 'userProgress', 'stats', 'gameRecords'),
        orderBy('timestamp', 'desc'),
        limit(limitCount)
      );
    } else {
      // For "All Time" view, get all sessions without limit
      q = query(
        collection(this.firestore, 'users', targetUserId, 'userProgress', 'stats', 'gameRecords'),
        orderBy('timestamp', 'desc')
      );
    }

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as GameSession);
  }

  /** Realtime subscription to user's game records */
  subscribeToGameRecords(onChange: (sessions: GameSession[]) => void): Unsubscribe {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    const colRef = collection(this.firestore, 'users', user.uid, 'userProgress', 'stats', 'gameRecords');
    const qy = query(colRef, orderBy('timestamp', 'desc'), limit(500));
    return onSnapshot(qy, (snap) => {
      const list = snap.docs.map(d => d.data() as GameSession);
      onChange(list);
    });
  }

  // ===== RECENT SESSIONS COLLECTION MANAGEMENT =====

  /**
   * Save a session to the recentSessions collection
   */
  async saveRecentSession(session: GameSession): Promise<string> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // Save to users/{uid}/userProgress/stats/recentSessions/{sessionId}
    const sessionRef = await addDoc(
      collection(this.firestore, 'users', user.uid, 'userProgress', 'stats', 'recentSessions'),
      this.sanitizeForFirestore(session)
    );

    console.log('Recent session saved:', sessionRef.id);
    
    return sessionRef.id;
  }

  /**
   * Get recent sessions from the recentSessions collection
   */
  async getRecentSessions(userId?: string, limitCount: number = 10): Promise<GameSession[]> {
    const user = this.getCurrentUser();
    const targetUserId = userId || user?.uid;

    if (!targetUserId) throw new Error('User not authenticated');

    const q = query(
      collection(this.firestore, 'users', targetUserId, 'userProgress', 'stats', 'recentSessions'),
      orderBy('timestamp', 'desc'),
      limit(limitCount)
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as GameSession);
  }

  /**
   * Realtime subscription to recent sessions
   */
  subscribeToRecentSessions(onChange: (sessions: GameSession[]) => void, limitCount: number = 10): Unsubscribe {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    
    const colRef = collection(this.firestore, 'users', user.uid, 'userProgress', 'stats', 'recentSessions');
    const qy = query(colRef, orderBy('timestamp', 'desc'), limit(limitCount));
    return onSnapshot(qy, (snap) => {
      const list = snap.docs.map(d => d.data() as GameSession);
      onChange(list);
    });
  }

  /**
   * Initialize recent sessions collection with existing game records
   */
  async initializeRecentSessions(): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    try {
      // Get existing game records
      const gameRecords = await this.getUserGameSessions();
      
      if (gameRecords.length > 0) {
        console.log('📊 Initializing recent sessions with', gameRecords.length, 'existing records');
        
        // Save the most recent 10 sessions to recentSessions collection
        const recentSessions = gameRecords.slice(0, 10);
        
        for (const session of recentSessions) {
          await this.saveRecentSession(session);
        }
        
        console.log('✅ Recent sessions collection initialized');
      }
    } catch (error) {
      console.error('❌ Error initializing recent sessions:', error);
    }
  }

  // ===== CATEGORY RECORDS MANAGEMENT =====

  /**
   * Save or update category records for a specific category
   */
  async saveCategoryRecord(category: string, recordData: Omit<CategoryRecord, 'category' | 'lastUpdated'>): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const categoryRecord: CategoryRecord = {
      category,
      ...recordData,
      lastUpdated: new Date().toISOString()
    };

    // Save to users/{uid}/userProgress/stats/categoryRecords/{category}
    await setDoc(
      doc(this.firestore, 'users', user.uid, 'userProgress', 'stats', 'categoryRecords', category),
      this.sanitizeForFirestore(categoryRecord)
    );

    console.log(`Category record saved for ${category}:`, categoryRecord);
  }

  /**
   * Get all category records for a user
   */
  async getCategoryRecords(userId?: string): Promise<CategoryRecord[]> {
    const user = this.getCurrentUser();
    const targetUserId = userId || user?.uid;

    if (!targetUserId) throw new Error('User not authenticated');

    const colRef = collection(this.firestore, 'users', targetUserId, 'userProgress', 'stats', 'categoryRecords');
    const querySnapshot = await getDocs(colRef);
    
    return querySnapshot.docs.map(doc => doc.data() as CategoryRecord);
  }

  /**
   * Get a specific category record
   */
  async getCategoryRecord(category: string, userId?: string): Promise<CategoryRecord | null> {
    const user = this.getCurrentUser();
    const targetUserId = userId || user?.uid;

    if (!targetUserId) throw new Error('User not authenticated');

    const docRef = doc(this.firestore, 'users', targetUserId, 'userProgress', 'stats', 'categoryRecords', category);
    const docSnap = await getDoc(docRef);
    
    return docSnap.exists() ? docSnap.data() as CategoryRecord : null;
  }

  /**
   * Realtime subscription to category records
   */
  subscribeToCategoryRecords(onChange: (records: CategoryRecord[]) => void): Unsubscribe {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    
    const colRef = collection(this.firestore, 'users', user.uid, 'userProgress', 'stats', 'categoryRecords');
    return onSnapshot(colRef, (snap) => {
      const list = snap.docs.map(d => d.data() as CategoryRecord);
      onChange(list);
    });
  }

  /**
   * Initialize category records for all game categories
   */
  async initializeCategoryRecords(): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const categories = ['people', 'places', 'objects', 'category-match'];
    
    for (const category of categories) {
      const existingRecord = await this.getCategoryRecord(category);
      if (!existingRecord) {
        const zeroRecord: Omit<CategoryRecord, 'category' | 'lastUpdated'> = {
          allTime: {
            accuracy: 0,
            avgTimePerCard: 0,
            cardsReviewed: 0,
            cardsSkipped: 0
          },
          month: {
            accuracy: 0,
            avgTimePerCard: 0,
            cardsReviewed: 0,
            cardsSkipped: 0
          },
          today: {
            accuracy: 0,
            avgTimePerCard: 0,
            cardsReviewed: 0,
            cardsSkipped: 0
          },
          week: {
            accuracy: 0,
            avgTimePerCard: 0,
            cardsReviewed: 0,
            cardsSkipped: 0
          }
        };

        await this.saveCategoryRecord(category, zeroRecord);
        console.log(`Initialized category record for ${category}`);
      }
    }
  }

  /**
   * Update category records based on game sessions
   */
  async updateCategoryRecordsFromSessions(sessions: GameSession[]): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const categories = ['people', 'places', 'objects', 'category-match'];
    
    for (const category of categories) {
      const categorySessions = sessions.filter(s => {
        const normalizedCategory = (s.category || '').toLowerCase().replace(/\s+/g, '-');
        return normalizedCategory === category || normalizedCategory === `name-that-memory-${category}`;
      });

      if (categorySessions.length > 0) {
        const recordData = this.calculateCategoryRecordData(categorySessions);
        await this.saveCategoryRecord(category, recordData);
      }
    }
  }

  /**
   * Calculate category record data from sessions
   */
  private calculateCategoryRecordData(sessions: GameSession[]): Omit<CategoryRecord, 'category' | 'lastUpdated'> {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    const calculateMetrics = (filteredSessions: GameSession[]) => {
      if (filteredSessions.length === 0) {
        return {
          accuracy: 0,
          avgTimePerCard: 0,
          cardsReviewed: 0,
          cardsSkipped: 0
        };
      }

      const totalQuestions = filteredSessions.reduce((sum, s) => sum + s.totalQuestions, 0);
      const totalCorrect = filteredSessions.reduce((sum, s) => sum + s.correctAnswers, 0);
      const totalTime = filteredSessions.reduce((sum, s) => sum + s.totalTime, 0);
      const totalSkipped = filteredSessions.reduce((sum, s) => sum + s.skipped, 0);

      return {
        accuracy: totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0,
        avgTimePerCard: totalQuestions > 0 ? Math.round(totalTime / totalQuestions) : 0,
        cardsReviewed: totalQuestions,
        cardsSkipped: totalSkipped
      };
    };

    const todaySessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp);
      return sessionDate >= today;
    });

    const weekSessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp);
      return sessionDate >= weekAgo;
    });

    const monthSessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp);
      return sessionDate >= monthAgo;
    });

    return {
      allTime: calculateMetrics(sessions),
      month: calculateMetrics(monthSessions),
      today: calculateMetrics(todaySessions),
      week: calculateMetrics(weekSessions)
    };
  }

  /** Update a flashcard under users/{uid}/flashcards/{cardId} */
  async updateFlashcard(cardId: string, updates: Partial<Record<string, any>>): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    await updateDoc(doc(this.firestore, 'users', user.uid, 'flashcards', cardId), this.sanitizeForFirestore(updates));
  }

  /** Update a flashcard in structured userFlashcards path */
  async updateStructuredFlashcard(cardId: string, category: string, updates: Partial<Record<string, any>>): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const sanitized = this.sanitizeForFirestore(updates);
    await updateDoc(doc(this.firestore, 'users', user.uid, 'userFlashcards', category, 'cards', cardId), sanitized);

    // Notify UI to refresh cross-views (same-device event)
    try { window.dispatchEvent(new CustomEvent('flashcard-updated', { detail: { cardId, category, updates } })); } catch {}
  }

  /** Delete a flashcard from structured userFlashcards path */
  async deleteFlashcard(cardId: string, category?: string): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // If category is provided, delete from structured path
    if (category) {
      try {
        await deleteDoc(doc(this.firestore, 'users', user.uid, 'userFlashcards', category, 'cards', cardId));
        // Notify UI to refresh cross-views (same-device event)
        try { window.dispatchEvent(new CustomEvent('flashcard-deleted', { detail: { cardId, category } })); } catch {}
        return;
      } catch (e) {
        console.warn('Failed to delete from structured path:', e);
      }
    }

    // Fallback: try to delete from old path
    const batch = writeBatch(this.firestore);

    // Delete the flashcard itself
    batch.delete(doc(this.firestore, 'users', user.uid, 'flashcards', cardId));

    // Delete any activities referencing this card (and their progress subcollections)
    const actsQ = query(collection(this.firestore, 'users', user.uid, 'activities'), where('cardId', '==', cardId));
    const actsSnap = await getDocs(actsQ);
    for (const a of actsSnap.docs) {
      // Delete progress subcollection entries
      const progSnap = await getDocs(collection(this.firestore, 'users', user.uid, 'activities', a.id, 'progress'));
      progSnap.docs.forEach(p => batch.delete(p.ref));
      // Delete the activity doc
      batch.delete(a.ref);
    }

    await batch.commit();

    // Notify UI to refresh cross-views (same-device event)
    try { window.dispatchEvent(new CustomEvent('flashcard-deleted', { detail: { cardId } })); } catch {}
  }

  async deleteFlashcardsByCategory(categoryName: string): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    try {
      // Query all flashcards in the category
      const cardsRef = collection(this.firestore, 'users', user.uid, 'userFlashcards', categoryName, 'cards');
      const cardsSnapshot = await getDocs(cardsRef);
      
      // Delete all flashcards in the category
      const batch = writeBatch(this.firestore);
      cardsSnapshot.forEach((doc) => {
        batch.delete(doc.ref);
      });
      
      await batch.commit();
      console.log(`✅ Deleted ${cardsSnapshot.size} flashcards from category: ${categoryName}`);
      
      // Notify UI to refresh cross-views
      try { 
        window.dispatchEvent(new CustomEvent('category-deleted', { detail: { categoryName } })); 
      } catch {}
    } catch (error) {
      console.error('Failed to delete flashcards by category:', error);
      throw error;
    }
  }

  async saveUserProgress(progressData: Partial<UserProgress>): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const updatedProgress = {
      ...progressData,
      lastUpdated: new Date().toISOString()
    };

    await setDoc(
      doc(this.firestore, 'users', user.uid, 'userProgress', 'stats'),
      updatedProgress,
      { merge: true }
    );
  }

  async getUserProgress(userId?: string): Promise<UserProgress | null> {
    const user = this.getCurrentUser();
    const targetUserId = userId || user?.uid;

    if (!targetUserId) throw new Error('User not authenticated');

    const docRef = doc(this.firestore, 'users', targetUserId, 'userProgress', 'stats');
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? docSnap.data() as UserProgress : null;
  }

  // ===== VIDEOS (Cloudinary + Firestore metadata) =====
  
  /** Upload video to Cloudinary and save metadata to Firestore */
  async uploadVideoToCloudinary(file: File, title?: string): Promise<{
    id: string;
    cloudinaryPublicId: string;
    videoUrl: string;
    thumbnailUrl: string;
    duration?: number;
    createdAt: number;
    title?: string;
  }> {
    const user = this.getCurrentUser();
    console.log('🔥 uploadVideoToCloudinary - Current user:', user?.uid || 'NO USER');
    
    if (!user) {
      console.error('❌ uploadVideoToCloudinary - User not authenticated');
      throw new Error('User not authenticated');
    }

    try {
      console.log('🔥 uploadVideoToCloudinary - Starting upload to Cloudinary...');
      
      // Upload to Cloudinary
      const cloudinaryResult = await this.cloudinaryService.uploadVideo(file, {
        title: title || file.name || 'Untitled Video',
        folder: `alala/users/${user.uid}/videos`
      });
      
      console.log('🔥 uploadVideoToCloudinary - Cloudinary upload successful:', cloudinaryResult);
      
      // Generate unique ID for Firestore
      const id = `vid_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      
      // Save metadata to Firestore
      const metadata = {
        id,
        userId: user.uid,
        cloudinaryPublicId: cloudinaryResult.publicId,
        videoUrl: cloudinaryResult.secureUrl,
        thumbnailUrl: this.cloudinaryService.getVideoThumbnail(cloudinaryResult.publicId),
        title: title || file.name || 'Untitled Video',
        duration: cloudinaryResult.duration,
        createdAt: Date.now(),
        width: cloudinaryResult.width,
        height: cloudinaryResult.height
      };
      
      console.log('🔥 uploadVideoToCloudinary - Saving metadata to Firestore:', metadata);
      await setDoc(doc(this.firestore, 'videoMemories', id), this.sanitizeForFirestore(metadata));
      
      console.log('🔥 uploadVideoToCloudinary - Upload complete');
      return {
        id,
        cloudinaryPublicId: cloudinaryResult.publicId,
        videoUrl: cloudinaryResult.secureUrl,
        thumbnailUrl: this.cloudinaryService.getVideoThumbnail(cloudinaryResult.publicId),
        duration: cloudinaryResult.duration,
        createdAt: metadata.createdAt,
        title: metadata.title
      };
    } catch (error) {
      console.error('❌ uploadVideoToCloudinary - Upload failed:', error);
      throw error;
    }
  }

  /** Delete video from both Cloudinary and Firestore */
  async deleteVideoFromCloudinary(videoId: string): Promise<boolean> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    try {
      console.log('🗑️ deleteVideoFromCloudinary - Deleting video:', videoId);
      
      // Get video metadata from Firestore
      const docRef = doc(this.firestore, 'videoMemories', videoId);
      const docSnap = await getDoc(docRef);
      
      if (!docSnap.exists()) {
        console.warn('⚠️ Video document not found in Firestore');
        return false;
      }
      
      const metadata = docSnap.data() as any;
      console.log('🗑️ Video metadata:', metadata);
      
      // Delete from Cloudinary
      if (metadata.cloudinaryPublicId) {
        const cloudinaryDeleted = await this.cloudinaryService.deleteVideo(metadata.cloudinaryPublicId);
        console.log('🗑️ Cloudinary deletion result:', cloudinaryDeleted);
      }
      
      // Delete from Firestore
      await deleteDoc(docRef);
      console.log('🗑️ Firestore document deleted');
      
      return true;
    } catch (error) {
      console.error('❌ deleteVideoFromCloudinary - Deletion failed:', error);
      return false;
    }
  }

  /** Update video metadata in both Cloudinary and Firestore */
  async updateVideoMetadata(videoId: string, updates: { title?: string; description?: string }): Promise<boolean> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    try {
      console.log('📝 updateVideoMetadata - Updating video:', videoId, updates);
      
      // Get current metadata
      const docRef = doc(this.firestore, 'videoMemories', videoId);
      const docSnap = await getDoc(docRef);
      
      if (!docSnap.exists()) {
        console.warn('⚠️ Video document not found');
        return false;
      }
      
      const currentMetadata = docSnap.data() as any;
      
      // Update Cloudinary metadata if publicId exists
      if (currentMetadata.cloudinaryPublicId && updates.title) {
        await this.cloudinaryService.updateVideoMetadata(currentMetadata.cloudinaryPublicId, {
          title: updates.title,
          description: updates.description
        });
      }
      
      // Update Firestore metadata
      await updateDoc(docRef, this.sanitizeForFirestore(updates));
      
      console.log('📝 updateVideoMetadata - Update complete');
      return true;
    } catch (error) {
      console.error('❌ updateVideoMetadata - Update failed:', error);
      return false;
    }
  }

  // ===== VIDEOS (Firebase Storage + Firestore metadata) =====
  /** Upload a user video to Firebase Storage and create metadata under users/{uid}/videos */
  async uploadUserVideo(file: Blob, label?: string): Promise<{ id: string; downloadURL: string; createdAt: number; storagePath: string; label?: string; }> {
    const user = this.getCurrentUser();
    console.log('🔥 uploadUserVideo - Current user:', user?.uid || 'NO USER');
    
    if (!user) {
      console.error('❌ uploadUserVideo - User not authenticated');
      throw new Error('User not authenticated');
    }

    console.log('🔥 uploadUserVideo - Starting upload for user:', user.uid);
    console.log('🔥 uploadUserVideo - File info:', { 
      size: file.size, 
      type: file.type, 
      label: label 
    });

    const id = `vid_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const path = `videos/${id}.mp4`;
    const storageRef = ref(this.storage, `users/${user.uid}/${path}`);
    
    console.log('🔥 uploadUserVideo - Storage path:', `users/${user.uid}/${path}`);
    
    try {
      console.log('🔥 uploadUserVideo - Uploading to Firebase Storage...');
      const snapshot = await uploadBytes(storageRef, file);
      console.log('🔥 uploadUserVideo - Upload successful, getting download URL...');
      
      const url = await getDownloadURL(snapshot.ref);
      console.log('🔥 uploadUserVideo - Download URL obtained:', url);

      const meta = { 
        id, 
        userId: user.uid, 
        storagePath: path, 
        downloadURL: url, 
        label: label || null, 
        createdAt: Date.now() 
      } as any;
      
      console.log('🔥 uploadUserVideo - Saving metadata to Firestore:', meta);
      await setDoc(doc(this.firestore, 'users', user.uid, 'videos', id), this.sanitizeForFirestore(meta));
      console.log('🔥 uploadUserVideo - Metadata saved successfully');
      
      const result = { id, downloadURL: url, createdAt: meta.createdAt, storagePath: path, label };
      console.log('🔥 uploadUserVideo - Upload complete:', result);
      return result;
    } catch (error) {
      console.error('❌ uploadUserVideo - Upload failed:', error);
      throw error;
    }
  }

  /** Subscribe to user's videos metadata for realtime updates */
  subscribeToVideos(onChange: (videos: Array<{ id: string; downloadURL: string; label?: string; createdAt: number }>) => void): Unsubscribe {
    const user = this.getCurrentUser();
    console.log('🔥 subscribeToVideos - Current user:', user?.uid || 'NO USER');
    
    if (!user) {
      console.error('❌ subscribeToVideos - User not authenticated');
      throw new Error('User not authenticated');
    }
    
    console.log('🔥 subscribeToVideos - Setting up subscription for user:', user.uid);
    // Look in the correct path: videoMemories/cards
    const colRef = collection(this.firestore, 'videoMemories');
    const qy = query(colRef, where('userId', '==', user.uid), orderBy('createdAt', 'desc'));
    
    return onSnapshot(qy, (snap) => {
      console.log('🔥 subscribeToVideos - Snapshot received:', snap.docs.length, 'videos');
      console.log('🔥 subscribeToVideos - Snapshot empty:', snap.empty);
      
      if (snap.empty) {
        console.log('🔥 subscribeToVideos - No videos found in Firebase');
        onChange([]);
        return;
      }
      
      const list = snap.docs.map(d => {
        const data = d.data() as any;
        console.log('🔥 subscribeToVideos - Video data:', data);
        return { 
          id: d.id, 
          downloadURL: data.videoUrl || data.videoURL, // Use videoUrl (Cloudinary) or videoURL (legacy)
          label: data.title || undefined, // Use title instead of label
          createdAt: data.createdAt,
          thumbnailUrl: data.thumbnailUrl, // Add thumbnail URL
          duration: data.duration, // Add duration
          cloudinaryPublicId: data.cloudinaryPublicId // Add Cloudinary public ID
        };
      });
      
      console.log('🔥 subscribeToVideos - Processed videos:', list);
      onChange(list);
    }, (error) => {
      console.error('❌ subscribeToVideos - Firebase error:', error);
    });
  }

  /** Debug method to manually fetch videos from Firebase */
  async debugGetVideos(): Promise<any[]> {
    const user = this.getCurrentUser();
    console.log('🔍 debugGetVideos - Current user:', user?.uid || 'NO USER');
    
    if (!user) {
      console.error('❌ debugGetVideos - User not authenticated');
      return [];
    }

    try {
      console.log('🔍 debugGetVideos - Fetching videos for user:', user.uid);
      // Look in the correct path: videoMemories/cards
      const colRef = collection(this.firestore, 'videoMemories');
      const qy = query(colRef, where('userId', '==', user.uid), orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(qy);
      
      console.log('🔍 debugGetVideos - Snapshot:', {
        empty: snapshot.empty,
        size: snapshot.size,
        docs: snapshot.docs.length
      });
      
      const videos = snapshot.docs.map(doc => {
        const data = doc.data();
        console.log('🔍 debugGetVideos - Video doc:', doc.id, data);
        return { id: doc.id, ...data };
      });
      
      console.log('🔍 debugGetVideos - All videos:', videos);
      return videos;
    } catch (error) {
      console.error('❌ debugGetVideos - Error:', error);
      return [];
    }
  }

  /** Delete a user video from both Firebase Storage and Firestore */
  async deleteUserVideo(videoId: string): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    
    const docRef = doc(this.firestore, 'users', user.uid, 'videos', videoId);
    const metaSnap = await getDoc(docRef);
    const meta: any = metaSnap.exists() ? metaSnap.data() : null;
    
    // Delete the video file from Firebase Storage
    if (meta?.storagePath) {
      try { 
        await deleteObject(ref(this.storage, `users/${user.uid}/${meta.storagePath}`)); 
        console.log('✅ Video file deleted from Firebase Storage');
      } catch (error) {
        console.warn('⚠️ Failed to delete video file from Storage:', error);
      }
    }
    
    // Delete the metadata from Firestore
    await deleteDoc(docRef);
    console.log('✅ Video metadata deleted from Firestore');
  }

  // ===== VIDEO MEMORIES inside userFlashcards =====
  /** Save a video memory under users/{uid}/userFlashcards/videoMemories/cards with duplicate prevention */
  async saveVideoMemory(input: { id?: string; title: string; videoURL: string; poster?: string | null }): Promise<string> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const title = (input.title || '').toString().trim();
    const videoURL = (input.videoURL || '').toString().trim();
    if (!title || !videoURL) throw new Error('Title and video URL are required');

    const colRef = collection(this.firestore, 'users', user.uid, 'userFlashcards', 'videoMemories', 'cards');

    // Duplicate check by title OR videoURL (wrapped in injection context)
    const [byTitleSnap, byUrlSnap] = await runInInjectionContext(this.injector, async () => {
      return await Promise.all([
        getDocs(query(colRef, where('titleLower', '==', title.toLowerCase()))),
        getDocs(query(colRef, where('videoURL', '==', videoURL)))
      ]);
    });

    if (!byTitleSnap.empty || !byUrlSnap.empty) {
      throw new Error('Duplicate video memory detected (same title or video URL)');
    }

    const id = input.id || `vm_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const data = this.sanitizeForFirestore({
      id,
      userId: user.uid,
      title,
      titleLower: title.toLowerCase(),
      videoURL,
      poster: input.poster || null,
      createdAt: Date.now(),
      category: 'videoMemories'
    });
    await setDoc(doc(this.firestore, 'users', user.uid, 'userFlashcards', 'videoMemories', 'cards', id), data);
    return id;
  }

  /** Realtime subscribe to video memories */
  subscribeToVideoMemories(onChange: (videos: Array<{ id: string; title: string; videoURL: string; poster?: string; createdAt: number }>) => void): Unsubscribe {
    const uid = this.getCurrentUser()?.uid || localStorage.getItem('userId') || '';
    if (!uid) throw new Error('User not authenticated');
    const qy = query(collection(this.firestore, 'users', uid, 'userFlashcards', 'videoMemories', 'cards'), orderBy('createdAt', 'desc'));
    return onSnapshot(qy, (snap) => {
      const list = snap.docs.map(d => d.data() as any).map(v => ({ id: v.id, title: v.title, videoURL: v.videoURL, poster: v.poster || undefined, createdAt: v.createdAt }));
      onChange(list);
    });
  }

  /** Delete a video memory from Firestore */
  async deleteVideoMemory(videoId: string): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    const docRef = doc(this.firestore, 'users', user.uid, 'userFlashcards', 'videoMemories', 'cards', videoId);
    await deleteDoc(docRef);
  }

  // ===== SECURITY CODE LOOKUP =====
  async findUserBySecurityCode(securityCode: string): Promise<{ uid: string; email?: string; name?: string } | null> {
    const qy = query(collection(this.firestore, 'users'), where('securityCode', '==', securityCode));
    const snap = await getDocs(qy);
    if (snap.empty) return null;
    const d = snap.docs[0];
    const data: any = d.data();
    return { uid: d.id, email: data?.email, name: data?.name };
  }

  /** Ensure a zeroed progress document exists for a user */
  private async initializeUserProgress(uid: string): Promise<void> {
    const statsRef = doc(this.firestore, 'users', uid, 'userProgress', 'stats');
    const existing = await getDoc(statsRef);
    
    // Always create/update the stats document to ensure it exists
    const zeroProgress: UserProgress = {
      // Time-based breakdown structure
      accuracyOverTime: {
        allTime: 0,
        month: 0,
        today: 0,
        week: 0
      },
      avgTimePerCard: {
        allTime: 0,
        month: 0,
        today: 0,
        week: 0
      },
      cardsReviewed: {
        allTime: 0,
        month: 0,
        today: 0,
        week: 0
      },
      cardsSkipped: {
        allTime: 0,
        month: 0,
        today: 0,
        week: 0
      },
      // Overall stats (all time)
      overallStats: {
        accuracy: 0,
        avgTimePerCard: 0,
        totalCards: 0,
        skippedCards: 0
      }
    };

    await setDoc(statsRef, this.sanitizeForFirestore(zeroProgress));
    console.log('📊 Stats document initialized for user:', uid);
    
    // Initialize category records collection
    await this.initializeCategoryRecords();
    
    // Initialize recent sessions collection
    await this.initializeRecentSessions();
  }

  /** Public helper to initialize progress for current user (used after login) */
  async ensureProgressInitialized(): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    await this.initializeUserProgress(user.uid);
  }

  /** Public helper to initialize category records for existing users */
  async ensureCategoryRecordsInitialized(): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    await this.initializeCategoryRecords();
  }

  /** Force recreate the stats document for existing users */
  async recreateStatsDocument(): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');
    
    console.log('🔄 Recreating stats document for user:', user.uid);
    await this.initializeUserProgress(user.uid);
    
    // Also update stats with current game records if they exist
    try {
      const gameRecords = await this.getUserGameSessions();
      if (gameRecords.length > 0) {
        console.log('📊 Found', gameRecords.length, 'game records, updating stats...');
        await this.updateUserStats({
          overallStats: {
            accuracy: 0,
            avgTimePerCard: 0,
            totalCards: 0,
            skippedCards: 0
          },
          accuracyOverTime: {
            allTime: 0,
            month: 0,
            today: 0,
            week: 0
          }
        });
        console.log('✅ Stats document recreated and updated successfully');
      }
    } catch (error) {
      console.error('❌ Error updating stats with existing records:', error);
    }
  }

  /** Update the stats document with calculated statistics */
  async updateUserStats(stats: {
    overallStats: any;
    accuracyOverTime: {
      today: number;
      week: number;
      month: number;
      allTime: number;
    };
    avgTimePerCard?: {
      today: number;
      week: number;
      month: number;
      allTime: number;
    };
    cardsReviewed?: {
      today: number;
      week: number;
      month: number;
      allTime: number;
    };
    cardsSkipped?: {
      today: number;
      week: number;
      month: number;
      allTime: number;
    };
  }): Promise<void> {
    try {
      console.log('🔥 Firebase updateUserStats called with:', stats);
      
      const user = this.getCurrentUser();
      if (!user) {
        console.error('❌ User not authenticated');
        throw new Error('User not authenticated');
      }

      console.log('🔥 User authenticated:', user.uid);

      const statsRef = doc(this.firestore, 'users', user.uid, 'userProgress', 'stats');
      
      const updatedStats: UserProgress = {
        // Time-based breakdown structure
        accuracyOverTime: stats.accuracyOverTime,
        avgTimePerCard: stats.avgTimePerCard || {
          allTime: stats.overallStats.avgTimePerCard,
          month: stats.overallStats.avgTimePerCard,
          today: stats.overallStats.avgTimePerCard,
          week: stats.overallStats.avgTimePerCard
        },
        cardsReviewed: stats.cardsReviewed || {
          allTime: stats.overallStats.totalCards,
          month: stats.overallStats.totalCards,
          today: stats.overallStats.totalCards,
          week: stats.overallStats.totalCards
        },
        cardsSkipped: stats.cardsSkipped || {
          allTime: stats.overallStats.skippedCards,
          month: stats.overallStats.skippedCards,
          today: stats.overallStats.skippedCards,
          week: stats.overallStats.skippedCards
        },
        // Overall stats (all time)
        overallStats: stats.overallStats
      };

      console.log('🔥 Prepared stats document:', updatedStats);

      const sanitizedStats = this.sanitizeForFirestore(updatedStats);
      console.log('🔥 Sanitized stats document:', sanitizedStats);

      await setDoc(statsRef, sanitizedStats);
      console.log('📊 Updated user stats in Firebase successfully');
      
      // Also update category records
      const recentSessions = await this.getRecentSessions();
      if (recentSessions.length > 0) {
        await this.updateCategoryRecordsFromSessions(recentSessions);
        console.log('📊 Updated category records successfully');
      }
    } catch (error) {
      console.error('❌ Failed to update user stats:', error);
      throw error;
    }
  }

  /** Offline-first support: Get cached data when Firebase is unavailable */
  getCachedData<T>(key: string, fallback: T): T {
    try {
      const uid = this.getCurrentUser()?.uid || localStorage.getItem('userId') || 'anon';
      const cachedKey = `${key}_${uid}`;
      const cached = localStorage.getItem(cachedKey);
      return cached ? JSON.parse(cached) : fallback;
    } catch (e) {
      console.warn(`Failed to get cached data for ${key}:`, e);
      return fallback;
    }
  }

  /** Offline-first support: Cache data locally */
  cacheData<T>(key: string, data: T): void {
    try {
      const uid = this.getCurrentUser()?.uid || localStorage.getItem('userId') || 'anon';
      const cacheKey = `${key}_${uid}`;
      localStorage.setItem(cacheKey, JSON.stringify(data));
    } catch (e) {
      console.warn(`Failed to cache data for ${key}:`, e);
    }
  }

  // ===== USER GALLERY MANAGEMENT =====

  /**
   * Create a new custom category for the current user
   */
  async createUserCategory(categoryData: Omit<UserCategory, 'id' | 'userId' | 'createdAt'>): Promise<string> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const categoryId = `cat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const category: UserCategory = {
      id: categoryId,
      userId: user.uid,
      createdAt: Date.now(),
      ...categoryData
    };

    await setDoc(doc(this.firestore, 'userCategories', categoryId), category);
    return categoryId;
  }

  /**
   * Get all categories for the current user
   */
  async getUserCategories(userId?: string): Promise<UserCategory[]> {
    const user = this.getCurrentUser();
    const targetUserId = userId || user?.uid;

    if (!targetUserId) throw new Error('User not authenticated');

    const q = query(
      collection(this.firestore, 'userCategories'),
      where('userId', '==', targetUserId),
      orderBy('createdAt', 'desc')
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as UserCategory);
  }

  /**
   * Update a user category
   */
  async updateUserCategory(categoryId: string, updates: Partial<Omit<UserCategory, 'id' | 'userId' | 'createdAt'>>): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // Verify ownership
    const categoryDoc = await getDoc(doc(this.firestore, 'userCategories', categoryId));
    const categoryData = categoryDoc.data() as UserCategory;
    if (!categoryDoc.exists() || categoryData?.userId !== user.uid) {
      throw new Error('Category not found or access denied');
    }

    await updateDoc(doc(this.firestore, 'userCategories', categoryId), updates);
  }

  /**
   * Delete a user category and all its cards
   */
  async deleteUserCategory(categoryId: string): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // Verify ownership
    const categoryDoc = await getDoc(doc(this.firestore, 'userCategories', categoryId));
    const categoryData = categoryDoc.data() as UserCategory;
    if (!categoryDoc.exists() || categoryData?.userId !== user.uid) {
      throw new Error('Category not found or access denied');
    }

    // Delete all cards in this category
    const cardsQuery = query(
      collection(this.firestore, 'userCards'),
      where('categoryId', '==', categoryId),
      where('userId', '==', user.uid)
    );

    const cardsSnapshot = await getDocs(cardsQuery);
    const batch = writeBatch(this.firestore);

    cardsSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Delete the category
    batch.delete(doc(this.firestore, 'userCategories', categoryId));

    await batch.commit();
  }

  // ===== USER CARD MANAGEMENT =====

  /**
   * Add a new card to a user's category
   */
  async createUserCard(cardData: Omit<UserCard, 'id' | 'userId' | 'createdAt'>): Promise<string> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // Verify category ownership
    const categoryDoc = await getDoc(doc(this.firestore, 'userCategories', cardData.categoryId));
    const categoryData = categoryDoc.data() as UserCategory;
    if (!categoryDoc.exists() || categoryData?.userId !== user.uid) {
      throw new Error('Category not found or access denied');
    }

    const cardId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const card: UserCard = {
      id: cardId,
      userId: user.uid,
      createdAt: Date.now(),
      ...cardData
    };

    await setDoc(doc(this.firestore, 'userCards', cardId), card);
    return cardId;
  }

  /**
   * Get all cards for a specific category
   */
  async getUserCards(categoryId: string, userId?: string): Promise<UserCard[]> {
    const user = this.getCurrentUser();
    const targetUserId = userId || user?.uid;

    if (!targetUserId) throw new Error('User not authenticated');

    const q = query(
      collection(this.firestore, 'userCards'),
      where('categoryId', '==', categoryId),
      where('userId', '==', targetUserId),
      orderBy('createdAt', 'desc')
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as UserCard);
  }

  /**
   * Get all cards for a user across all categories
   */
  async getAllUserCards(userId?: string): Promise<UserCard[]> {
    const user = this.getCurrentUser();
    const targetUserId = userId || user?.uid;

    if (!targetUserId) throw new Error('User not authenticated');

    const q = query(
      collection(this.firestore, 'userCards'),
      where('userId', '==', targetUserId),
      orderBy('createdAt', 'desc'),
      limit(500) // Reasonable limit
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as UserCard);
  }

  /**
   * Update a user card
   */
  async updateUserCard(cardId: string, updates: Partial<Omit<UserCard, 'id' | 'userId' | 'createdAt'>>): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // Verify ownership
    const cardDoc = await getDoc(doc(this.firestore, 'userCards', cardId));
    const cardData = cardDoc.data() as UserCard;
    if (!cardDoc.exists() || cardData?.userId !== user.uid) {
      throw new Error('Card not found or access denied');
    }

    await updateDoc(doc(this.firestore, 'userCards', cardId), updates);
  }

  /**
   * Delete a user card
   */
  async deleteUserCard(cardId: string): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // Verify ownership
    const cardDoc = await getDoc(doc(this.firestore, 'userCards', cardId));
    const cardData = cardDoc.data() as UserCard;
    if (!cardDoc.exists() || cardData?.userId !== user.uid) {
      throw new Error('Card not found or access denied');
    }

    await deleteDoc(doc(this.firestore, 'userCards', cardId));
  }

  // ===== FILE UPLOAD MANAGEMENT =====

  /**
   * Upload a file (image/audio) to Firebase Storage
   */
  async uploadFile(file: Blob, path: string): Promise<string> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const storageRef = ref(this.storage, `users/${user.uid}/${path}`);
    const snapshot = await uploadBytes(storageRef, file);
    return await getDownloadURL(snapshot.ref);
  }

  /**
   * Delete a file from Firebase Storage
   */
  async deleteFile(path: string): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const storageRef = ref(this.storage, `users/${user.uid}/${path}`);
    await deleteObject(storageRef);
  }

  // ===== DATA MIGRATION HELPERS =====

  /**
   * Migrate local storage data to Firebase for the current user
   */
  async migrateLocalDataToFirebase(): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    console.log('🔄 Starting data migration to Firebase...');

    // Migrate custom categories
    const userSpecificKey = `alala_custom_categories_v1_${user.uid}`;
    const localCategories = localStorage.getItem(userSpecificKey);
    if (localCategories) {
      const categories = JSON.parse(localCategories);
      for (const category of categories) {
        try {
          await this.createUserCategory({
            name: category.name,
            description: category.description,
            emoji: category.emoji
          });
          console.log(`✅ Migrated category: ${category.name}`);
        } catch (error) {
          console.error(`❌ Failed to migrate category ${category.name}:`, error);
        }
      }
    }

    // Migrate game sessions
    const localSessions = localStorage.getItem('gameSessions');
    if (localSessions) {
      const sessions = JSON.parse(localSessions);
      for (const session of sessions) {
        try {
          await this.saveGameSession(session);
          console.log(`✅ Migrated game session from ${session.timestamp}`);
        } catch (error) {
          console.error(`❌ Failed to migrate game session:`, error);
        }
      }
    }

    console.log('✅ Data migration completed');
  }

  /**
   * Clear all user data (for account deletion)
   */
  async clearAllUserData(): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    const batch = writeBatch(this.firestore);

    // Delete all user categories
    const categoriesQuery = query(
      collection(this.firestore, 'userCategories'),
      where('userId', '==', user.uid)
    );
    const categoriesSnapshot = await getDocs(categoriesQuery);
    categoriesSnapshot.docs.forEach(doc => batch.delete(doc.ref));

    // Delete all user cards
    const cardsQuery = query(
      collection(this.firestore, 'userCards'),
      where('userId', '==', user.uid)
    );
    const cardsSnapshot = await getDocs(cardsQuery);
    cardsSnapshot.docs.forEach(doc => batch.delete(doc.ref));

    // Delete activities and progress under users/{uid}/activities
    const acts = await getDocs(collection(this.firestore, 'users', user.uid, 'activities'));
    for (const a of acts.docs) {
      const prog = await getDocs(collection(this.firestore, 'users', user.uid, 'activities', a.id, 'progress'));
      prog.docs.forEach(p => batch.delete(p.ref));
      batch.delete(a.ref);
    }

    // Delete videos metadata under users/{uid}/videos
    const vids = await getDocs(collection(this.firestore, 'users', user.uid, 'videos'));
    vids.docs.forEach(v => batch.delete(v.ref));

    // Delete structured flashcards under users/{uid}/userFlashcards/*/cards
    const buckets = ['people','places','objects','custom-category','photo-memories','videoMemories'];
    for (const b of buckets) {
      const cards = await getDocs(collection(this.firestore, 'users', user.uid, 'userFlashcards', b, 'cards'));
      cards.docs.forEach(c => batch.delete(c.ref));
    }

    // Delete user progress (includes Category Match sessions)
    batch.delete(doc(this.firestore, 'users', user.uid, 'userProgress', 'stats'));

    // Delete user profile
    batch.delete(doc(this.firestore, 'users', user.uid));

    await batch.commit();
  }

  // ===== TRUSTED CONTACTS MANAGEMENT =====

  /**
   * Add a trusted contact relationship
   */
  async addTrustedContact(patientUserId: string, caregiverUserId: string, contactInfo: any): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // Only the patient or caregiver can create this relationship
    if (user.uid !== patientUserId && user.uid !== caregiverUserId) {
      throw new Error('Access denied');
    }

    const contactId = `${caregiverUserId}_${patientUserId}`;
    const trustedContact = {
      id: contactId,
      patientUserId,
      caregiverUserId,
      ...contactInfo,
      createdAt: new Date().toISOString(),
      createdBy: user.uid
    };

    await setDoc(doc(this.firestore, 'trustedContacts', contactId), trustedContact);
  }

  /**
   * Get trusted contacts for a user (both as patient and caregiver)
   */
  async getTrustedContacts(): Promise<any[]> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // Get contacts where user is the patient
    const asPatientQuery = query(
      collection(this.firestore, 'trustedContacts'),
      where('patientUserId', '==', user.uid)
    );

    // Get contacts where user is the caregiver
    const asCaregiverQuery = query(
      collection(this.firestore, 'trustedContacts'),
      where('caregiverUserId', '==', user.uid)
    );

    const [patientSnapshot, caregiverSnapshot] = await Promise.all([
      getDocs(asPatientQuery),
      getDocs(asCaregiverQuery)
    ]);

    const contacts = [
      ...patientSnapshot.docs.map(doc => ({ ...doc.data(), role: 'patient' })),
      ...caregiverSnapshot.docs.map(doc => ({ ...doc.data(), role: 'caregiver' }))
    ];

    return contacts;
  }

  /**
   * Remove a trusted contact relationship
   */
  async removeTrustedContact(contactId: string): Promise<void> {
    const user = this.getCurrentUser();
    if (!user) throw new Error('User not authenticated');

    // Verify the user is part of this relationship
    const contactDoc = await getDoc(doc(this.firestore, 'trustedContacts', contactId));
    if (!contactDoc.exists()) {
      throw new Error('Contact relationship not found');
    }

    const contactData = contactDoc.data() as TrustedContact;
    if (contactData?.patientUserId !== user.uid && contactData?.caregiverUserId !== user.uid) {
      throw new Error('Access denied');
    }

    await deleteDoc(doc(this.firestore, 'trustedContacts', contactId));
  }

  /**
   * Verify if a user can access another user's data (trusted contact check)
   */
  async canAccessUserData(targetUserId: string): Promise<boolean> {
    const user = this.getCurrentUser();
    if (!user) return false;

    // Users can always access their own data
    if (user.uid === targetUserId) return true;

    // Check if there's a trusted contact relationship
    const contactId = `${user.uid}_${targetUserId}`;
    const contactDoc = await getDoc(doc(this.firestore, 'trustedContacts', contactId));

    return contactDoc.exists();
  }
}