import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, ToastController, LoadingController } from '@ionic/angular';
import { FirebaseService } from '../../services/firebase.service';
import type { Unsubscribe } from '@firebase/firestore';


@Component({
  selector: 'app-home',
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss'],
  standalone: false
})
export class HomePage implements OnInit, OnDestroy {
  isPatientMode = false;

  // profile values shown in the header
  userPhoto = '';
  userName = '';

  // Today's progress stats
  todayStats = {
    accuracy: 0,
    cardsToday: 0,
    avgTime: 0
  };

  // listeners
  private profileListener?: (e: any) => void;
  private sessionsUnsub?: Unsubscribe;

  constructor(
    private router: Router,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController,
    private loadingCtrl: LoadingController,
    private firebaseService: FirebaseService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.isPatientMode = localStorage.getItem('patientMode') === 'true';
    this.loadUserProfile();
    this.loadTodayStats();
    this.attachRealtimeToday();

    // Update Home immediately when Settings saves profile
    this.profileListener = () => this.loadUserProfile();
    window.addEventListener('user-profile-updated', this.profileListener);
    
    // Listen for user login events to refresh data
    window.addEventListener('user-logged-in', (e: any) => {
      console.log('Home page: User logged in event received', e.detail);
      this.loadUserProfile();
      this.loadTodayStats();
    });
  }

  ngOnDestroy(): void {
    if (this.profileListener) {
      window.removeEventListener('user-profile-updated', this.profileListener);
    }
    try { this.sessionsUnsub?.(); } catch {}
  }

  ionViewWillEnter() {
    // Refresh today's stats when user returns to home page
    this.loadTodayStats();
    // Also refresh user profile in case it was updated elsewhere
    this.loadUserProfile();
  }

  async loadTodayStats() {
    try {
      // Check if user is authenticated
      const currentUser = this.firebaseService.getCurrentUser();
      if (!currentUser) {
        console.log('📊 User not authenticated, showing empty stats');
        this.todayStats = { accuracy: 0, cardsToday: 0, avgTime: 0 };
        return;
      }

      // Get today's sessions
      const todaySessions = await this.getTodaySessions();

      if (todaySessions.length === 0) {
        this.todayStats = { accuracy: 0, cardsToday: 0, avgTime: 0 };
        return;
      }

      // Calculate today's stats
      const totalQuestions = todaySessions.reduce((sum: number, s: any) => sum + s.totalQuestions, 0);
      const totalCorrect = todaySessions.reduce((sum: number, s: any) => sum + s.correctAnswers, 0);
      const totalTime = todaySessions.reduce((sum: number, s: any) => sum + s.totalTime, 0);

      this.todayStats = {
        accuracy: totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0,
        cardsToday: totalQuestions,
        avgTime: totalQuestions > 0 ? Math.round(totalTime / totalQuestions) : 0
      };

      console.log('📊 Today\'s stats loaded:', this.todayStats);
    } catch (error) {
      console.error('Error loading today\'s stats:', error);
      this.todayStats = { accuracy: 0, cardsToday: 0, avgTime: 0 };
    }
  }

  private attachRealtimeToday() {
    try {
      this.sessionsUnsub?.();
      this.sessionsUnsub = this.firebaseService.subscribeToGameSessions((sessions) => {
        // Filter for today and update stats in realtime
        const today = new Date();
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
        const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
        const todaySessions = (sessions || []).filter((s: any) => {
          const t = new Date(s.timestamp);
          return t >= startOfDay && t <= endOfDay;
        });

        if (todaySessions.length === 0) {
          this.todayStats = { accuracy: 0, cardsToday: 0, avgTime: 0 };
          return;
        }
        const totalQuestions = todaySessions.reduce((sum: number, s: any) => sum + (s.totalQuestions || 0), 0);
        const totalCorrect  = todaySessions.reduce((sum: number, s: any) => sum + (s.correctAnswers || 0), 0);
        const totalTime     = todaySessions.reduce((sum: number, s: any) => sum + (s.totalTime || 0), 0);
        this.todayStats = {
          accuracy: totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0,
          cardsToday: totalQuestions,
          avgTime: totalQuestions > 0 ? Math.round(totalTime / totalQuestions) : 0
        };
      });
    } catch {}
  }

  async getTodaySessions() {
    try {
      const allSessions = await this.firebaseService.getUserGameSessions();

      // Filter for today's sessions
      const today = new Date();
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
      const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

      const todaySessions = allSessions.filter((session: any) => {
        let sessionDate: Date;
        if (typeof session.timestamp === 'string') {
          sessionDate = new Date(session.timestamp);
        } else if (typeof session.timestamp === 'number') {
          sessionDate = new Date(session.timestamp);
        } else {
          return false;
        }

        return sessionDate >= startOfDay && sessionDate <= endOfDay;
      });

      return todaySessions;
    } catch (error) {
      console.error('Error getting today\'s sessions:', error);
      // Fallback to localStorage (per-user)
      const uid = localStorage.getItem('userId');
      const key = uid ? `gameSessions:${uid}` : 'gameSessions';
      const sessions = localStorage.getItem(key);
      if (!sessions) return [];

      const allSessions = JSON.parse(sessions);
      const today = new Date();
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
      const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

      return allSessions.filter((session: any) => {
        const sessionDate = new Date(session.timestamp);
        return sessionDate >= startOfDay && sessionDate <= endOfDay;
      });
    }
  }

  /* ---------------- Profile ---------------- */
  private async loadUserProfile() {
    try {
      console.log('🔄 Loading user profile...');
      
      // Get user profile from Firebase
      const userProfile = await this.firebaseService.getUserProfile();
      console.log('📊 Firebase user profile:', userProfile);
      
      if (userProfile) {
        // Use Firebase user data
        this.userName = userProfile.name || userProfile.patientInfo?.name || 'User';
        // Add cache-busting parameter to force image refresh
        this.userPhoto = userProfile.photo ? `${userProfile.photo}?t=${Date.now()}` : '';
        
        console.log(`🏠 Home page: Loaded profile from Firebase - Name: ${this.userName}, Photo: ${this.userPhoto ? 'Present' : 'Not present'}`);
      } else {
        // Fallback to Firebase auth user
        const user = this.firebaseService.getCurrentUser();
        this.userName = user?.displayName || 'Guest';
        this.userPhoto = '';
        
        console.log(`🏠 Home page: Using Firebase auth user: ${this.userName}`);
      }
      
      // Additional fallback to local storage if Firebase data is not available
      if (!this.userName || this.userName === 'Guest') {
        const raw = localStorage.getItem('userData');
        const data = raw ? JSON.parse(raw) : {};
        this.userName = data?.name || data?.caregiverInfo?.name || data?.patientInfo?.name || 'User';
        this.userPhoto = data?.photo ? `${data.photo}?t=${Date.now()}` : '';
        
        console.log(`🏠 Home page: Fallback to localStorage - Name: ${this.userName}, Photo: ${this.userPhoto ? 'Present' : 'Not present'}`);
      }
      
      // Force change detection to update the UI
      this.cdr.detectChanges();
      
    } catch (e) {
      console.warn('Error loading user profile:', e);
      this.userPhoto = '';
      this.userName = 'User';
    }
  }

  /* ---------------- Refresh Data ---------------- */
  async refreshData() {
    console.log('🔄 Manual refresh triggered');
    try {
      // Show loading state
      const loading = await this.loadingCtrl.create({
        message: 'Refreshing data...',
        duration: 1000
      });
      await loading.present();

      // Refresh all data
      await Promise.all([
        this.loadUserProfile(),
        this.loadTodayStats()
      ]);

      await loading.dismiss();
      
      // Show success toast
      const toast = await this.toastCtrl.create({
        message: 'Data refreshed successfully!',
        duration: 2000,
        position: 'top',
        color: 'success'
      });
      await toast.present();
      
    } catch (error) {
      console.error('Error refreshing data:', error);
      
      const toast = await this.toastCtrl.create({
        message: 'Error refreshing data',
        duration: 2000,
        position: 'top',
        color: 'danger'
      });
      await toast.present();
    }
  }

  /* ---------------- Patient Mode ---------------- */
  // Enable via card button
  async enablePatientMode() {
    const savedPin = localStorage.getItem('caregiverPin');

    // If no password exists yet, require setting it first in Settings
    if (!savedPin) {
      const alert = await this.alertCtrl.create({
        header: 'Set Caregiver Password',
        message:
          'To use Patient Mode, please create a caregiver password first. You will need it to exit Patient Mode.',
        buttons: [
          { text: 'Cancel', role: 'cancel' },
          {
            text: 'Go to Settings',
            handler: () => this.router.navigate(['/settings'])
          }
        ],
        backdropDismiss: false
      });
      await alert.present();
      return;
    }

    // Password exists → allow entering Patient Mode
    this.isPatientMode = true;
    localStorage.setItem('patientMode', 'true');
    this.presentToast('Patient Mode enabled');
    // notify others (e.g., pages listening)
    window.dispatchEvent(new CustomEvent('patientMode-changed', { detail: true }));
  }

  // Header chip toggle behavior
  async onPatientModeToggle() {
    if (!this.isPatientMode) {
      // Try to enable; will enforce "set password first" if missing
      await this.enablePatientMode();
      return;
    }
    // Exiting still requires password (unchanged)
    await this.promptExitPatientMode();
  }

  public async promptExitPatientMode() {
    const alert = await this.alertCtrl.create({
      header: 'Exit Patient Mode',
      message: 'Enter caregiver password to switch back to Standard mode.',
      inputs: [
        {
          name: 'pin',
          type: 'password',
          placeholder: 'Enter password',
          attributes: { maxlength: 32 }
        }
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Unlock',
          handler: (data) => this.verifyAndExitPatientMode(data?.pin)
        }
      ],
      backdropDismiss: false
    });
    await alert.present();
  }

  private async verifyAndExitPatientMode(inputPin: string) {
    const savedPin = localStorage.getItem('caregiverPin');

    if (!savedPin) {
      const alert = await this.alertCtrl.create({
        header: 'No Password Set',
        message:
          'To exit Patient Mode, please set a caregiver password first in Settings.',
        buttons: [
          { text: 'Cancel', role: 'cancel' },
          {
            text: 'Go to Settings',
            handler: () => this.router.navigate(['/settings'])
          }
        ]
      });
      await alert.present();
      return false;
    }

    if (!inputPin || inputPin !== savedPin) {
      this.presentToast('Incorrect password', 'danger');
      return false;
    }

    this.isPatientMode = false;
    localStorage.setItem('patientMode', 'false');
    this.presentToast('Standard Mode enabled');
    // notify others
    window.dispatchEvent(new CustomEvent('patientMode-changed', { detail: false }));
    return true;
  }

  // Not used directly anymore for PM flow but kept if referenced elsewhere
  togglePatientMode() {
    if (!this.isPatientMode) {
      // route through enablePatientMode to enforce password requirement
      this.enablePatientMode();
    } else {
      this.promptExitPatientMode();
    }
  }


  /* ---------------- Misc / shared ---------------- */
  navigateToGame(gameType: string) {
    switch (gameType) {
      case 'name-that-memory':
        this.router.navigate(['/name-that-memory-select']);
        break;
      case 'category-match':
        this.router.navigate(['/category-match']);
        break;
      case 'memory-matching':
        this.router.navigate(['/memory-matching']);
        break;
      case 'color-sequence':
        this.router.navigate(['/color-sequence']);
        break;
      default:
        console.log('Game not implemented yet:', gameType);
    }
  }

  private async presentToast(
    message: string,
    color: 'success' | 'warning' | 'danger' | 'primary' = 'primary'
  ) {
    const toast = await this.toastCtrl.create({
      message,
      duration: 1700,
      color,
      position: 'bottom'
    });
    await toast.present();
  }
}
