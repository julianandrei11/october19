import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { FirebaseService } from '../../services/firebase.service';
import { Unsubscribe } from '@angular/fire/firestore';
import { ViewWillEnter, ViewDidEnter } from '@ionic/angular';

@Component({
  selector: 'app-progress',
  templateUrl: './progress.page.html',
  styleUrls: ['./progress.page.scss'],
  standalone: false
})
export class ProgressPage implements OnInit, OnDestroy, ViewWillEnter, ViewDidEnter {
  @ViewChild('accuracyChart', { static: false }) accuracyChart!: ElementRef;

  selectedPeriod: string = 'today';
  customStartDate: string = '';
  customEndDate: string = '';
  isPatientMode = false;
  
  chart: any;
  chartLoaded = false;
  isLoading = true;

  // Add Firebase connection status properties
  isFirebaseConnected: boolean = false;
  dataSource: string = 'Loading...';

  // Real-time subscription management
  private gameRecordsUnsubscribe?: Unsubscribe;
  private autoRefreshInterval?: any;
  private lastDataUpdate = 0;

  overallStats = {
    accuracy: 0,
    avgTimePerCard: 0,
    totalCards: 0,
    skippedCards: 0
  };

  insights: any[] = [];
  hasDataForPeriod: boolean = false;

  // Date range picker state
  isDateRangePickerOpen = false;

  constructor(private firebaseService: FirebaseService) {}

  async ngOnInit() {
    await this.loadChartJS();
    await this.loadProgressData();
    this.generateInsights();
    if (this.chartLoaded) {
      await this.createChart();
    }

    // Subscribe to real-time game sessions for live updates
    this.subscribeToGameRecords();

    // Set up automatic refresh every 30 seconds as fallback
    this.setupAutoRefresh();

    // Listen for user login events to refresh data
    window.addEventListener('user-logged-in', (e: any) => {
      console.log('Progress page: User logged in event received', e.detail);
      this.loadProgressData();
      this.generateInsights();
      if (this.chartLoaded) {
        this.createChart();
      }
      this.subscribeToGameRecords();
    });

    // Listen for game session completion events
    window.addEventListener('game-session-completed', (e: any) => {
      console.log('Progress page: Game session completed event received', e.detail);
      this.handleNewGameSession(e.detail);
    });
  }

  ngOnDestroy() {
    // Clean up subscriptions and intervals
    if (this.gameRecordsUnsubscribe) {
      this.gameRecordsUnsubscribe();
    }
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval);
    }
  }

  ionViewWillEnter() {
    // Called when the page is about to enter and become the active page
    console.log('Progress tab: About to enter - preparing real-time sync');
  }

  ionViewDidEnter() {
    // Called when the page has fully entered and is now the active page
    console.log('Progress tab: Did enter - triggering real-time sync');
    this.triggerRealtimeSync();
  }

  async loadChartJS() {
    try {
      if ((window as any).Chart) {
        this.chartLoaded = true;
        console.log('Chart.js already loaded');
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
      script.onload = () => {
        this.chartLoaded = true;
        console.log('Chart.js loaded successfully');
      };
      script.onerror = () => {
        console.error('Failed to load Chart.js');
        this.chartLoaded = false;
      };
      document.head.appendChild(script);
    } catch (error) {
      console.error('Failed to load Chart.js:', error);
      this.chartLoaded = false;
    }
  }

  /**
   * Load progress data (attempt Firebase first, but always set
   * connection flag based on whether Firebase read succeeded).
   */
  async loadProgressData() {
    try {
      console.log(' Loading progress data...');
      this.isLoading = true;
      this.lastDataUpdate = Date.now();

      // Prefer Firebase. Try to get sessions; if call succeeds we treat Firebase as connected,
      // even if it returns zero sessions (that means user has no sessions yet).
      let sessions: any[] = [];
      try {
        sessions = await this.firebaseService.getUserGameSessions();
        this.isFirebaseConnected = true;
        this.dataSource = 'Firebase';
        console.log(`Fetched ${sessions.length} sessions from Firebase`);
      } catch (fbErr) {
        console.warn(' Firebase fetch failed, falling back to cached/local data', fbErr);
        this.isFirebaseConnected = false;
        // fallback to cached data
        sessions = this.firebaseService.getCachedData('gameRecords', []);
        if (!sessions || sessions.length === 0) {
          // last fallback: user-scoped localStorage key
          const uid = localStorage.getItem('userId');
          const localKey = uid ? `gameRecords_${uid}` : 'gameRecords';
          const raw = localStorage.getItem(localKey) || localStorage.getItem('gameRecords') || '[]';
          try { sessions = JSON.parse(raw); } catch { sessions = []; }
          this.dataSource = sessions && sessions.length > 0 ? 'Local Storage' : 'No Data';
        } else {
          this.dataSource = 'Cached Data';
        }
        console.log(`Using ${this.dataSource} (${sessions.length})`);
      }

      // compute stats & chart (respect current selectedPeriod for the cards/stats)
      const filtered = this.filterSessionsByPeriod(sessions || []);
      if (filtered && filtered.length > 0) {
        this.calculateOverallStats(filtered);
        this.firebaseService.cacheData('gameRecords', sessions);
        
        // Update Firebase stats with comprehensive data
        try {
          await this.updateFirebaseStats(sessions || []);
          console.log('Firebase stats update completed successfully');
        } catch (error) {
          console.error(' Firebase stats update failed:', error);
        }
      } else {
        // zeroed out if empty
        this.overallStats = { accuracy: 0, avgTimePerCard: 0, totalCards: 0, skippedCards: 0 };
        
        // Still update Firebase with zero stats
        try {
          await this.updateFirebaseStats([]);
          console.log('Firebase stats update completed (zero stats)');
        } catch (error) {
          console.error('Firebase stats update failed (zero stats):', error);
        }
      }

      this.isLoading = false;
    } catch (error) {
      console.error('Error loading progress data:', error);
      this.dataSource = 'Error';
      this.isLoading = false;
    }
  }

  /** Calculate accuracy over different time periods */
  calculateAccuracyOverTime(sessions: any[]) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    const calculateAccuracy = (filteredSessions: any[]) => {
      if (filteredSessions.length === 0) return 0;
      const totalQuestions = filteredSessions.reduce((sum, s) => sum + (s.totalQuestions || 0), 0);
      const totalCorrect = filteredSessions.reduce((sum, s) => sum + (s.correctAnswers || 0), 0);
      return totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
    };

    const todaySessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= today;
    });

    const weekSessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= weekAgo;
    });

    const monthSessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= monthAgo;
    });

    return {
      allTime: this.calculateAllTimeAccuracy(sessions),
      month: calculateAccuracy(monthSessions),
      today: calculateAccuracy(todaySessions),
      week: calculateAccuracy(weekSessions)
    };
  }

  /** Calculate average time per card over different time periods */
  calculateAvgTimePerCardOverTime(sessions: any[]) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    const calculateAvgTime = (filteredSessions: any[]) => {
      if (filteredSessions.length === 0) return 0;
      const totalQuestions = filteredSessions.reduce((sum, s) => sum + (s.totalQuestions || 0), 0);
      const totalTime = filteredSessions.reduce((sum, s) => sum + (s.totalTime || 0), 0);
      return totalQuestions > 0 ? Math.round(totalTime / totalQuestions) : 0;
    };

    const todaySessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= today;
    });

    const weekSessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= weekAgo;
    });

    const monthSessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= monthAgo;
    });

    return {
      allTime: this.calculateAllTimeAvgTime(sessions),
      month: calculateAvgTime(monthSessions),
      today: calculateAvgTime(todaySessions),
      week: calculateAvgTime(weekSessions)
    };
  }

  /** Calculate cards reviewed over different time periods */
  calculateCardsReviewedOverTime(sessions: any[]) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    const calculateCardsReviewed = (filteredSessions: any[]) => {
      return filteredSessions.reduce((sum, s) => sum + (s.totalQuestions || 0), 0);
    };

    const todaySessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= today;
    });

    const weekSessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= weekAgo;
    });

    const monthSessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= monthAgo;
    });

    return {
      allTime: this.calculateAllTimeCardsReviewed(sessions),
      month: calculateCardsReviewed(monthSessions),
      today: calculateCardsReviewed(todaySessions),
      week: calculateCardsReviewed(weekSessions)
    };
  }

  /** Calculate cards skipped over different time periods */
  calculateCardsSkippedOverTime(sessions: any[]) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    const calculateCardsSkipped = (filteredSessions: any[]) => {
      return filteredSessions.reduce((sum, s) => sum + (s.skipped || 0), 0);
    };

    const todaySessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= today;
    });

    const weekSessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= weekAgo;
    });

    const monthSessions = sessions.filter(s => {
      const sessionDate = new Date(s.timestamp || s.createdAt || 0);
      return sessionDate >= monthAgo;
    });

    return {
      allTime: this.calculateAllTimeCardsSkipped(sessions),
      month: calculateCardsSkipped(monthSessions),
      today: calculateCardsSkipped(todaySessions),
      week: calculateCardsSkipped(weekSessions)
    };
  }

  // NEW SIMPLIFIED ALL TIME CALCULATIONS - START FROM SCRATCH
  /** Calculate All Time accuracy - simple aggregation of all sessions */
  calculateAllTimeAccuracy(sessions: any[]): number {
    if (!sessions || sessions.length === 0) return 0;
    
    const totalQuestions = sessions.reduce((sum, s) => sum + (s.totalQuestions || 0), 0);
    const totalCorrect = sessions.reduce((sum, s) => sum + (s.correctAnswers || 0), 0);
    
    return totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
  }

  /** Calculate All Time average time per card - simple aggregation */
  calculateAllTimeAvgTime(sessions: any[]): number {
    if (!sessions || sessions.length === 0) return 0;
    
    const totalQuestions = sessions.reduce((sum, s) => sum + (s.totalQuestions || 0), 0);
    const totalTime = sessions.reduce((sum, s) => sum + (s.totalTime || 0), 0);
    
    return totalQuestions > 0 ? Math.round(totalTime / totalQuestions) : 0;
  }

  /** Calculate All Time cards reviewed - simple sum */
  calculateAllTimeCardsReviewed(sessions: any[]): number {
    if (!sessions || sessions.length === 0) return 0;
    
    return sessions.reduce((sum, s) => sum + (s.totalQuestions || 0), 0);
  }

  /** Calculate All Time cards skipped - simple sum */
  calculateAllTimeCardsSkipped(sessions: any[]): number {
    if (!sessions || sessions.length === 0) return 0;
    
    return sessions.reduce((sum, s) => sum + (s.skipped || 0), 0);
  }

  /** Update Firebase stats document with calculated statistics */
  async updateFirebaseStats(sessions: any[]) {
    try {
      console.log('updateFirebaseStats called with:', {
        isFirebaseConnected: this.isFirebaseConnected,
        sessionsCount: sessions.length,
        overallStats: this.overallStats
      });

      if (!this.isFirebaseConnected) {
        console.log('Firebase not connected, skipping stats update');
        return;
      }

      const accuracyOverTime = this.calculateAccuracyOverTime(sessions);
      const avgTimePerCard = this.calculateAvgTimePerCardOverTime(sessions);
      const cardsReviewed = this.calculateCardsReviewedOverTime(sessions);
      const cardsSkipped = this.calculateCardsSkippedOverTime(sessions);
      
      console.log('Calculated time-based stats:', {
        accuracyOverTime,
        avgTimePerCard,
        cardsReviewed,
        cardsSkipped
      });
      
      const statsData = {
        overallStats: this.overallStats,
        accuracyOverTime: accuracyOverTime,
        avgTimePerCard: avgTimePerCard,
        cardsReviewed: cardsReviewed,
        cardsSkipped: cardsSkipped,
        recentSessions: sessions.slice(0, 10)
      };

      console.log('Sending stats data to Firebase:', statsData);
      
      await this.firebaseService.updateUserStats(statsData);

      console.log('Successfully updated Firebase stats');
    } catch (error) {
      console.error('Failed to update Firebase stats:', error);
    }
  }

  calculateOverallStats(sessions: any[]) {
    if (sessions.length === 0) {
      this.overallStats = {
        accuracy: 0,
        avgTimePerCard: 0,
        totalCards: 0,
        skippedCards: 0
      };
      return;
    }

    const totalQuestions = sessions.reduce((sum, s) => sum + (s.totalQuestions || 0), 0);
    const totalCorrect = sessions.reduce((sum, s) => sum + (s.correctAnswers || 0), 0);
    const totalTime = sessions.reduce((sum, s) => sum + (s.totalTime || 0), 0);
    const totalSkipped = sessions.reduce((sum, s) => sum + (s.skipped || 0), 0);

    this.overallStats = {
      accuracy: totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0,
      avgTimePerCard: totalQuestions > 0 ? Math.round(totalTime / totalQuestions) : 0,
      totalCards: totalQuestions,
      skippedCards: totalSkipped
    };

    console.log(`Overall Stats: ${totalCorrect}/${totalQuestions} = ${this.overallStats.accuracy}%`);
  }




  /** Create the Chart.js chart using computed chart data */
  async createChart() {
    if (!this.accuracyChart || !this.chartLoaded || !(window as any).Chart) {
      console.log('Chart creation skipped - missing requirements');
      return;
    }

    try {
      const ctx = this.accuracyChart.nativeElement.getContext('2d');
      if (!ctx) {
        console.error('Failed to get canvas context');
        return;
      }

      const chartData = await this.getChartData();

      if (this.chart) {
        this.chart.destroy();
      }

      console.log('Creating chart with', chartData.datasets.length, 'datasets');

      // Determine chart type based on selected period
      const chartType = this.selectedPeriod === 'today' ? 'bar' : 'line';

      this.chart = new (window as any).Chart(ctx, {
        type: chartType,
        data: chartData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true,
              position: 'bottom'
            },
            tooltip: {
              mode: 'index',
              intersect: false
            }
          },
          interaction: {
            mode: 'index',
            intersect: false
          },
          scales: {
            y: {
              beginAtZero: true,
              max: 100,
              ticks: {
                callback: function(value: any) {
                  return value + '%';
                }
              }
            }
          },
          elements: chartType === 'bar' ? {
            // Bar chart specific styling
            bar: {
              borderWidth: 1,
              borderRadius: 4,
              borderSkipped: false
            }
          } : {
            // Line chart specific styling
            line: {
              tension: 0.3,
              borderWidth: 2
            },
            point: {
              radius: 3,
              borderWidth: 2
            }
          }
        }
      });

      console.log('Chart created successfully with', this.chart.data.datasets.length, 'datasets');
    } catch (error) {
      console.error('Error creating chart:', error);
    }
  }

  /**
   * Get chart data for current period using Firebase (preferred) or cached/local fallback.
   * Produces labels array and 4 datasets (people, places, objects, category-match).
   */
  async getChartData() {
    console.log(`Getting chart data for period: ${this.selectedPeriod}`);
    try {
      // Fetch sessions 
      let sessions: any[] = [];
      try {
        // ENHANCED APPROACH: Get all sessions for All Time, optimized for other periods
        if (this.selectedPeriod === 'all') {
          console.log(`All Time: Fetching ALL sessions from Firebase for current user...`);
          sessions = await this.firebaseService.getUserGameSessions(); // No limit for All Time
          console.log(`All Time: Retrieved ${sessions.length} sessions from Firebase`);
        } else {
          console.log(`${this.selectedPeriod}: Fetching recent sessions from Firebase...`);
          sessions = await this.firebaseService.getUserGameSessions(undefined, 100); // Limit for performance
          console.log(`${this.selectedPeriod}: Retrieved ${sessions.length} sessions from Firebase`);
        }
        this.isFirebaseConnected = true;
        this.dataSource = 'Firebase';
      } catch (fbErr) {
        console.warn(' Firebase sessions fetch failed; using cached/local sessions', fbErr);
        this.isFirebaseConnected = false;
        sessions = this.firebaseService.getCachedData('gameRecords', []);
        console.log(`Retrieved ${sessions.length} sessions from cached data`);
        if ((!sessions || sessions.length === 0)) {
          const uid = localStorage.getItem('userId');
          const localKey = uid ? `gameRecords_${uid}` : 'gameRecords';
          const raw = localStorage.getItem(localKey) || '[]';
          try { 
            sessions = JSON.parse(raw); 
            console.log(`Retrieved ${sessions.length} sessions from localStorage (${localKey})`);
          } catch { 
            sessions = []; 
            console.log('Failed to parse localStorage sessions');
          }
        }
      }


      if (!sessions || sessions.length === 0) {
        console.log('No sessions available for chart');
        this.hasDataForPeriod = false;
        // return default empty chart structure with 4 series and single "No Data" label
        const labels = this.selectedPeriod === 'today' ? ['No Activity Today'] : ['No Data'];
        const emptyDataset = (label: string, color: string) => ({
          label,
          data: [0],
          borderColor: color,
          backgroundColor: color + '33',
          fill: false,
          tension: 0.3
        });
        return {
          labels,
          datasets: [
            emptyDataset('Name That Memory - People', '#3b82f6'),
            emptyDataset('Name That Memory - Places', '#10b981'),
            emptyDataset('Name That Memory - Objects', '#f59e0b'),
            emptyDataset('Category Match', '#ef4444')
          ]
        } as any;
      }

      // Build labels (date buckets) based on selectedPeriod and available session dates
      const dateRange = this.getChartDateRangeFromSessions(sessions);
      const labels = dateRange.map(d => d.label);

      console.log(`Date range: ${labels.join(', ')}`);

      // Group sessions into the same bucket keys
      const grouped = this.groupSessionsIntoBuckets(sessions, dateRange);

      // Category definitions for datasets
      const cats = [
        { key: 'people', label: 'Name That Memory - People', color: '#3b82f6' },
        { key: 'places', label: 'Name That Memory - Places', color: '#10b981' },
        { key: 'objects', label: 'Name That Memory - Objects', color: '#f59e0b' },
        { key: 'category-match', label: 'Category Match', color: '#ef4444' }
      ];

      // For each category, build an array of accuracy values aligned with labels
      const datasets = cats.map(cat => {
        const data = dateRange.map((dr, drIdx) => {
          const bucketKey = dr.key;
          const allBucketSessions = grouped[bucketKey] || [];
          const bucketSessions: any[] = allBucketSessions.filter((s: any) => this.isSessionInCategory(s, cat.key));

          if (!bucketSessions || bucketSessions.length === 0) {
            if (this.selectedPeriod === 'all') {
              console.log(`All Time: No ${cat.key} sessions for date ${dr.label} (${bucketKey})`);
            }
            return 0;
          }
          
          const totalCorrect = bucketSessions.reduce((sum, s) => sum + (s.correctAnswers || 0), 0);
          const totalQuestions = bucketSessions.reduce((sum, s) => sum + (s.totalQuestions || 0), 0);
          const accuracy = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
          
          if (this.selectedPeriod === 'all') {
            console.log(`All Time: ${cat.key} on ${dr.label}: ${totalCorrect}/${totalQuestions} = ${accuracy}% (${bucketSessions.length} sessions)`);
          }
          
          return accuracy;
        });

        return {
          label: cat.label,
          data,
          borderColor: cat.color,
          backgroundColor: this.selectedPeriod === 'today' ? cat.color + '80' : cat.color + '33', // More opaque for bar chart
          borderWidth: this.selectedPeriod === 'today' ? 1 : 2,
          fill: false,
          tension: this.selectedPeriod === 'today' ? 0 : 0.3, // No tension for bar chart
          pointRadius: this.selectedPeriod === 'today' ? 0 : 3, // No points for bar chart
          pointBorderWidth: this.selectedPeriod === 'today' ? 0 : 2,
          pointBackgroundColor: cat.color,
          pointBorderColor: '#fff'
        } as any;
      });

      this.hasDataForPeriod = true;
      const chartData = { labels, datasets };
      console.log('Chart data generated with', datasets.length, 'datasets');
      return chartData;
    } catch (error) {
      console.error('Error generating chart data:', error);
      return { labels: ['Error'], datasets: [] } as any;
    }
  }

  // Decide whether a session belongs to a category key
  private isSessionInCategory(session: any, catKey: string): boolean {
  const c = (session.category || '').toString().toLowerCase().replace(/\s+/g, '-'); // normalize spaces to dash
  if (catKey === 'category-match') {
    return c === 'category-match' || c === 'categorymatch' || c === 'category match';
  } else {
    return c === catKey || c === `name-that-memory-${catKey}`;
  }
}



  /**
   * Build date range buckets based on the selectedPeriod and available sessions.
   * Returns array of { key, label, dateStart, dateEnd }.
   * - key: internal string used to group sessions
   * - label: display label for chart x-axis
   *
   * CHANGED: Removed 'all' handling. Implemented:
   *  - 'today' => last 7 days (labels: Mon, Oct 6)
   *  - 'week'  => last 4 weekly buckets (labels: Week 1..4)
   *  - 'month' => last 4 monthly buckets (labels: Month 1..4)
   */
  private getChartDateRangeFromSessions(sessions: any[]) {
    const now = new Date();
    const buckets: Array<{ key: string; label: string; start: Date; end: Date }> = [];

   
if (this.selectedPeriod === 'today') {
  const today = new Date();
  const startDate = new Date(today);
  startDate.setHours(0, 0, 0, 0);
  
  const endDate = new Date(today);
  endDate.setHours(23, 59, 59, 999);

  // Use local date key to avoid timezone issues
  const localYear = today.getFullYear();
  const localMonth = String(today.getMonth() + 1).padStart(2, '0');
  const localDay = String(today.getDate()).padStart(2, '0');
  const key = `${localYear}-${localMonth}-${localDay}`;
  
  const label = today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  
  console.log(`Today (GMT+8): ${label} (${key}) - ${startDate.toLocaleString()} to ${endDate.toLocaleString()}`);
  
  buckets.push({ key, label, start: startDate, end: endDate });
  return buckets;
}


  
if (this.selectedPeriod === 'week') {
  if (sessions.length === 0) {
    // No sessions, show today only
    const today = new Date();
    const startDate = new Date(today);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);
    
    const localYear = today.getFullYear();
    const localMonth = String(today.getMonth() + 1).padStart(2, '0');
    const localDay = String(today.getDate()).padStart(2, '0');
    const key = `${localYear}-${localMonth}-${localDay}`;
    
    const label = today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    buckets.push({ key, label, start: startDate, end: endDate });
    return buckets;
  }

  // Find the earliest session date using local time
  const earliestSession = sessions.reduce((earliest, session) => {
    const sessionDate = new Date(session.timestamp || session.createdAt || 0);
    return sessionDate < earliest ? sessionDate : earliest;
  }, new Date(sessions[0].timestamp || sessions[0].createdAt || 0));

  console.log(`Week: Starting from earliest session: ${earliestSession.toLocaleDateString()} (GMT+8)`);

  // Create 8 days starting from the first session day
  for (let i = 0; i < 8; i++) {
    const dayStart = new Date(earliestSession);
    dayStart.setDate(earliestSession.getDate() + i);
    dayStart.setHours(0, 0, 0, 0);
    
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    // Use local date key
    const localYear = dayStart.getFullYear();
    const localMonth = String(dayStart.getMonth() + 1).padStart(2, '0');
    const localDay = String(dayStart.getDate()).padStart(2, '0');
    const key = `${localYear}-${localMonth}-${localDay}`;
    
    const label = dayStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    buckets.push({ key, label, start: dayStart, end: dayEnd });
  }
  return buckets;
}

// MONTH — show first month when sessions started + 4 months ahead
if (this.selectedPeriod === 'month') {
  if (sessions.length === 0) {
    // No sessions, show current month
    const monthCursor = new Date(now.getFullYear(), now.getMonth(), 1);
    const year = monthCursor.getFullYear();
    const month = monthCursor.getMonth();
    const monthStart = new Date(year, month, 1, 0,0,0,0);
    const monthEnd = new Date(year, month + 1, 0, 23,59,59,999);
    const key = `${monthStart.getFullYear()}-${String(monthStart.getMonth()+1).padStart(2,'0')}`;
    const label = monthStart.toLocaleDateString('en-US', { month: 'short' });
    buckets.push({ key, label, start: monthStart, end: monthEnd });
    return buckets;
  }

  // Find the earliest session date using local time
  const earliestSession = sessions.reduce((earliest, session) => {
    const sessionDate = new Date(session.timestamp || session.createdAt || 0);
    return sessionDate < earliest ? sessionDate : earliest;
  }, new Date(sessions[0].timestamp || sessions[0].createdAt || 0));

  console.log(`Month: Starting from earliest session: ${earliestSession.toLocaleDateString()} (GMT+8)`);

  // Create 5 months starting from the first session month
  for (let i = 0; i < 5; i++) {
    const monthStart = new Date(earliestSession.getFullYear(), earliestSession.getMonth() + i, 1, 0, 0, 0, 0);
    const monthEnd = new Date(earliestSession.getFullYear(), earliestSession.getMonth() + i + 1, 0, 23, 59, 59, 999);

    const key = `${monthStart.getFullYear()}-${String(monthStart.getMonth()+1).padStart(2,'0')}`;
    const label = monthStart.toLocaleDateString('en-US', { month: 'short' });
    
    console.log(`Month bucket ${i + 1}: ${label} (${key}) - ${monthStart.toLocaleDateString()} to ${monthEnd.toLocaleDateString()}`);
    
    buckets.push({ key, label, start: monthStart, end: monthEnd });
  }
  
  console.log(`Month: Created ${buckets.length} monthly buckets:`, buckets.map(b => `${b.label} (${b.key})`));
  return buckets;
}




    // ALL TIME — ENHANCED IMPLEMENTATION FOR ACCURATE DATA
    if (this.selectedPeriod === 'all') {
      console.log(`All Time: Processing ${sessions.length} sessions for current user`);
      
      if (!sessions || sessions.length === 0) {
        console.log(`No sessions found for All Time period`);
        return buckets;
      }
      
      // Debug: Log all sessions to understand the data structure
      console.log(`All Time: Session data structure:`, sessions.map(s => ({
        category: s.category,
        timestamp: s.timestamp,
        createdAt: s.createdAt,
        correctAnswers: s.correctAnswers,
        totalQuestions: s.totalQuestions,
        dateKey: new Date(s.timestamp || s.createdAt || 0).toISOString().split('T')[0]
      })));
      
      // Enhanced approach: Get all unique dates from sessions with proper validation
      const sessionDates = new Set<string>();
      const currentDate = new Date();
      const todayKey = currentDate.toISOString().split('T')[0];
      console.log(`Current date/time: ${currentDate.toISOString()} (${todayKey})`);
      console.log(`Current local date: ${currentDate.toLocaleDateString()}`);
      
      sessions.forEach((session, index) => {
        const timestamp = session.timestamp || session.createdAt || 0;
        const sessionDate = new Date(timestamp);
        
        // Validate the date
        if (isNaN(sessionDate.getTime())) {
          console.warn(`Invalid timestamp for session ${index}:`, timestamp);
          return;
        }
        
        const dateKey = sessionDate.toISOString().split('T')[0];
        const localDateKey = sessionDate.toLocaleDateString('en-CA'); // YYYY-MM-DD format
        
        // Alternative: Use local date to avoid timezone issues
        const localYear = sessionDate.getFullYear();
        const localMonth = String(sessionDate.getMonth() + 1).padStart(2, '0');
        const localDay = String(sessionDate.getDate()).padStart(2, '0');
        const localDateKeyAlt = `${localYear}-${localMonth}-${localDay}`;
        
        // Special debugging for October 23rd
        if (dateKey.includes('2025-10-23') || localDateKey.includes('2025-10-23') || localDateKeyAlt.includes('2025-10-23')) {
          console.log(`OCT 23 DEBUG - Session ${index + 1}:`, {
            category: session.category,
            rawTimestamp: timestamp,
            sessionDate: sessionDate.toISOString(),
            localDate: sessionDate.toLocaleDateString(),
            utcDateKey: dateKey,
            localDateKey: localDateKey,
            localDateKeyAlt: localDateKeyAlt,
            correctAnswers: session.correctAnswers,
            totalQuestions: session.totalQuestions,
            isToday: dateKey === todayKey
          });
        }
        
        // Use local date key to avoid timezone issues
        sessionDates.add(localDateKeyAlt);
        console.log(`Session ${index + 1}: ${session.category} on ${localDateKeyAlt} (UTC: ${dateKey}) (${session.correctAnswers}/${session.totalQuestions})`);
      });
      
      // Convert to sorted array and create buckets
      const sortedDates = Array.from(sessionDates).sort();
      console.log(`All Time: Found ${sortedDates.length} unique dates with game records:`, sortedDates);
      
      // Check specifically for October 23rd
      const oct23Included = sortedDates.includes('2025-10-23');
      console.log(`October 23rd included in dates: ${oct23Included}`);
      if (!oct23Included) {
        console.log(`October 23rd is MISSING from the chart dates!`);
        console.log(`Available dates:`, sortedDates);
        
        // Check if we have any sessions that should be October 23rd
        const oct23Sessions = sessions.filter(s => {
          const sessionDate = new Date(s.timestamp || s.createdAt || 0);
          const localYear = sessionDate.getFullYear();
          const localMonth = String(sessionDate.getMonth() + 1).padStart(2, '0');
          const localDay = String(sessionDate.getDate()).padStart(2, '0');
          const localDateKey = `${localYear}-${localMonth}-${localDay}`;
          return localDateKey.includes('2025-10-23');
        });
        console.log(`Sessions that should be Oct 23:`, oct23Sessions.length);
        oct23Sessions.forEach((s, i) => {
          const sessionDate = new Date(s.timestamp || s.createdAt || 0);
          const localYear = sessionDate.getFullYear();
          const localMonth = String(sessionDate.getMonth() + 1).padStart(2, '0');
          const localDay = String(sessionDate.getDate()).padStart(2, '0');
          const localDateKey = `${localYear}-${localMonth}-${localDay}`;
          console.log(`   Session ${i + 1}: ${s.category} - ${s.timestamp} -> ${localDateKey}`);
        });
      }
      
      // Create date buckets for each unique date
      sortedDates.forEach(dateKey => {
        const date = new Date(dateKey);
        const startDate = new Date(date);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(date);
        endDate.setHours(23, 59, 59, 999);
        
        const label = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        buckets.push({ key: dateKey, label, start: startDate, end: endDate });
        
        // Debug: Count sessions for this date
        const sessionsForDate = sessions.filter(s => {
          const sessionDate = new Date(s.timestamp || s.createdAt || 0);
          const localYear = sessionDate.getFullYear();
          const localMonth = String(sessionDate.getMonth() + 1).padStart(2, '0');
          const localDay = String(sessionDate.getDate()).padStart(2, '0');
          const localDateKey = `${localYear}-${localMonth}-${localDay}`;
          return localDateKey === dateKey;
        });
        console.log(`Date ${dateKey}: ${sessionsForDate.length} sessions`);
        
        // Special debug for October 23rd
        if (dateKey === '2025-10-23') {
          console.log(`OCT 23 BUCKET CREATED:`, {
            dateKey,
            label,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            sessionCount: sessionsForDate.length
          });
        }
      });
      
      console.log(`All Time: Created ${buckets.length} date buckets:`, buckets.map(b => `${b.label} (${b.key})`));
      return buckets;
    }

    // CUSTOM — fallback to day-by-day between selected custom dates
    if (this.selectedPeriod === 'custom') {
      const start = this.customStartDate ? new Date(this.customStartDate) : new Date();
      const end = this.customEndDate ? new Date(this.customEndDate) : new Date();
      // normalize
      start.setHours(0,0,0,0);
      end.setHours(23,59,59,999);
      const cur = new Date(start);
      
      console.log(`Custom: From ${start.toLocaleDateString()} to ${end.toLocaleDateString()} (GMT+8)`);
      
      while (cur <= end) {
        // Use local date key
        const localYear = cur.getFullYear();
        const localMonth = String(cur.getMonth() + 1).padStart(2, '0');
        const localDay = String(cur.getDate()).padStart(2, '0');
        const key = `${localYear}-${localMonth}-${localDay}`;
        
        const label = cur.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        buckets.push({ key, label, start: new Date(cur), end: new Date(cur.getTime() + 24*3600*1000 - 1) });
        cur.setDate(cur.getDate() + 1);
      }
      return buckets;
    }

    // Default (fallback): produce last 7 days
    {
      console.log(`Default: Last 7 days (GMT+8)`);
      for (let i = 6; i >= 0; i--) {
        const dStart = new Date();
        dStart.setDate(dStart.getDate() - i);
        dStart.setHours(0,0,0,0);
        const dEnd = new Date(dStart.getTime() + 24*3600*1000 - 1);
        
        // Use local date key
        const localYear = dStart.getFullYear();
        const localMonth = String(dStart.getMonth() + 1).padStart(2, '0');
        const localDay = String(dStart.getDate()).padStart(2, '0');
        const key = `${localYear}-${localMonth}-${localDay}`;
        
        const label = dStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        buckets.push({ key, label, start: dStart, end: dEnd });
      }
      return buckets;
    }
  }

  /**
   * Group sessions into the date/month buckets described by dateRange.
   * Returns a map: { bucketKey: [sessions] }
   */
  private groupSessionsIntoBuckets(sessions: any[], dateRange: Array<{ key: string; label: string; start: Date; end: Date }>) {
    const map: Record<string, any[]> = {};
    for (const dr of dateRange) map[dr.key] = [];
    
    for (const s of sessions) {
      const ts = (s.timestamp || s.createdAt || 0);
      const sessionDate = new Date(ts);
      
      // Find matching date range bucket
      for (const dr of dateRange) {
        // Check if session falls within this bucket's date range
        if (sessionDate >= dr.start && sessionDate <= dr.end) {
          map[dr.key].push(s);
          break;
        }
      }
    }
    
    // Debug logging for monthly buckets
    if (this.selectedPeriod === 'month') {
      console.log(`Monthly grouping results:`);
      Object.keys(map).forEach(key => {
        console.log(`   ${key}: ${map[key].length} sessions`);
        if (map[key].length > 0) {
          map[key].forEach((session, i) => {
            const sessionDate = new Date(session.timestamp || session.createdAt || 0);
            console.log(`     Session ${i + 1}: ${session.category} on ${sessionDate.toLocaleDateString()} (${session.correctAnswers}/${session.totalQuestions})`);
          });
        }
      });
    }
    
    return map;
  }

  /**
   * Update the existing chart (replace labels + datasets)
   */
  async updateChart() {
    if (!this.chart) {
      await this.createChart();
      return;
    }
    try {
      const chartData = await this.getChartData();

      // Destroy and recreate the chart to ensure all datasets render properly
      this.chart.destroy();
      await this.createChart();

      console.log('Chart recreated for period:', this.selectedPeriod);
    } catch (error) {
      console.error('Error updating chart:', error);
    }
  }



  generateInsights() {
    this.insights = [];

    if (this.overallStats.accuracy >= 80) {
      this.insights.push({
        icon: '🎯',
        title: 'Excellent Accuracy',
        message: `Great job! Your accuracy of ${this.overallStats.accuracy}% shows strong memory retention.`
      });
    } else if (this.overallStats.accuracy >= 60) {
      this.insights.push({
        icon: '👍',
        title: 'Good Progress',
        message: `You're doing well with ${this.overallStats.accuracy}% accuracy. Keep practicing!`
      });
    } else if (this.overallStats.accuracy > 0) {
      this.insights.push({
        icon: '💪',
        title: 'Keep Practicing',
        message: 'Practice makes perfect! Try focusing on accuracy over speed.'
      });
    }

    if (this.overallStats.avgTimePerCard > 10) {
      this.insights.push({
        icon: '⏰',
        title: 'Take Your Time',
        message: 'No rush! Taking time to think helps with memory formation.'
      });
    }
  }



  // Static method for other pages to save game sessions
  static async saveGameSession(firebaseService: FirebaseService, sessionData: {
  category: string;
  totalQuestions: number;
  correctAnswers: number;
  skipped: number;
  totalTime: number;
  timestamp?: number;
}, progressPageInstance?: ProgressPage) {
  try {
    const sessionWithTimestamp = { ...sessionData, timestamp: sessionData.timestamp || Date.now() };

    // Save to Firebase
    await firebaseService.saveGameSession(sessionWithTimestamp);

    // Save to localStorage as backup
    const uid = localStorage.getItem('userId');
    const key = uid ? `gameRecords_${uid}` : 'gameRecords';
    const sessions = JSON.parse(localStorage.getItem(key) || '[]');
    sessions.push(sessionWithTimestamp);
    localStorage.setItem(key, JSON.stringify(sessions));

    console.log('Game session saved (Firebase + Local Storage)', sessionWithTimestamp);

    // Auto-refresh progress if instance is passed
    if (progressPageInstance) {
      await progressPageInstance.recalculateForCurrentFilter();
    }
  } catch (error) {
    console.error('Error saving game session:', error);
  }
}




  /**
   * getGameSessionData: tries Firebase first, fallback to cached/local.
   * Returns sessions filtered to current selected period.
   */
  async getGameSessionData() {
    try {
      let allSessions: any[] = [];
      try {
        allSessions = await this.firebaseService.getUserGameSessions();
        this.isFirebaseConnected = true;
        this.dataSource = 'Firebase';
      } catch (fbErr) {
        console.warn('getGameSessionData: firebase fetch failed', fbErr);
        this.isFirebaseConnected = false;
        allSessions = this.firebaseService.getCachedData('gameRecords', []);
        if ((!allSessions || allSessions.length === 0)) {
          const uid = localStorage.getItem('userId');
          const localKey = uid ? `gameRecords_${uid}` : 'gameRecords';
          const raw = localStorage.getItem(localKey) || '[]';
          try { allSessions = JSON.parse(raw); } catch { allSessions = []; }
        }
      }
      return this.filterSessionsByPeriod(allSessions);
    } catch (error) {
      console.error('Error getting game session data:', error);
    }
    return [];
  }

  filterSessionsByPeriod(sessions: any[]) {
    // All Time: include all sessions
    if (this.selectedPeriod === 'all') {
      return sessions.slice();
    }
    
    const dateBuckets = this.getChartDateRangeFromSessions(sessions);
    if (!dateBuckets || dateBuckets.length === 0) return [];

    const start = dateBuckets[0].start;
    const end = dateBuckets[dateBuckets.length - 1].end;

    return sessions.filter(session => {
      const ts = session.timestamp || session.createdAt || 0;
      const sessionDate = new Date(ts);
      return sessionDate >= start && sessionDate <= end;
    });
  }


  onPeriodChange() {
    // Recalculate stats and chart for new period
    this.recalculateForCurrentFilter();
  }

  onCustomDateChange() {
    if (this.customStartDate && this.customEndDate) {
      this.recalculateForCurrentFilter();
    }
  }

  togglePatientMode() {
    this.isPatientMode = !this.isPatientMode;
    console.log('Patient mode toggled:', this.isPatientMode);
  }

  private subscribeToGameRecords() {
    try {
      // Unsubscribe from previous subscription if exists
      if (this.gameRecordsUnsubscribe) {
        this.gameRecordsUnsubscribe();
      }

      this.gameRecordsUnsubscribe = this.firebaseService.subscribeToGameRecords((sessions) => {
        console.log('Progress page: Received real-time game sessions:', sessions.length);
        this.lastDataUpdate = Date.now();
        this.isFirebaseConnected = true;
        this.dataSource = 'Firebase (Real-time)';
        
        const filtered = this.filterSessionsByPeriod(sessions);
        this.calculateOverallStats(filtered);
        this.generateInsights();
        
        // Update chart asynchronously
        this.updateChart();
        
        // Cache the latest data
        this.firebaseService.cacheData('gameRecords', sessions);
      });
    } catch (e) {
      console.error('Failed to subscribe to game sessions:', e);
      this.isFirebaseConnected = false;
      this.dataSource = 'Offline';
    }
  }

  private setupAutoRefresh() {
    // Set up automatic refresh every 30 seconds as fallback
    this.autoRefreshInterval = setInterval(() => {
      const timeSinceLastUpdate = Date.now() - this.lastDataUpdate;
      
      // Only refresh if it's been more than 30 seconds since last update
      if (timeSinceLastUpdate > 30000) {
        console.log('Auto-refreshing progress data (fallback)');
        this.loadProgressData();
        if (this.chartLoaded) {
          this.updateChart();
        }
      }
    }, 3000); // 30 seconds
  }

  private async handleNewGameSession(sessionData: any) {
    console.log('Handling new game session:', sessionData);
    
    // Immediately update the UI with the new session
    try {
      // Get current sessions and add the new one
      let sessions: any[] = [];
      try {
        sessions = await this.firebaseService.getUserGameSessions();
      } catch (error) {
        // Fallback to cached data
        sessions = this.firebaseService.getCachedData('gameRecords', []);
      }
      
      // Add the new session
      sessions.unshift(sessionData);
      
      // Update stats immediately
      const filtered = this.filterSessionsByPeriod(sessions);
      this.calculateOverallStats(filtered);
      this.generateInsights();
      
      // Update chart
      if (this.chartLoaded) {
        await this.updateChart();
      }
      
      console.log('Progress updated with new session');
    } catch (error) {
      console.error('Error handling new game session:', error);
    }
  }

  async triggerRealtimeSync() {
    console.log('Progress tab: Triggering real-time sync from Firebase');
    
    try {
      // Force refresh data from Firebase
      await this.loadProgressData();
      
      // Ensure real-time subscription is active
      this.subscribeToGameRecords();
      
      // Update chart with latest data
      if (this.chartLoaded) {
        await this.updateChart();
      }
      
      // Update Firebase stats
      try {
        const sessions = await this.firebaseService.getUserGameSessions();
        await this.updateFirebaseStats(sessions);
      } catch (error) {
        console.warn('Could not update Firebase stats during sync:', error);
      }
      
      console.log('Progress tab: Real-time sync completed');
    } catch (error) {
      console.error('Progress tab: Real-time sync failed:', error);
    }
  }

  /** Recompute stats and chart for the currently selected period */
  private async recalculateForCurrentFilter() {
    const sessions = await this.getGameSessionData();
    this.calculateOverallStats(sessions);
    await this.updateChart();
  }

  // Date range picker methods
  toggleDateRangePicker() {
    this.isDateRangePickerOpen = !this.isDateRangePickerOpen;
  }

  closeDateRangePicker() {
    this.isDateRangePickerOpen = false;
  }

  applyDateRange() {
    this.isDateRangePickerOpen = false;
    this.onCustomDateChange();
  }

  getDateRangeText(): string {
    if (!this.customStartDate || !this.customEndDate) {
      return 'Select date range';
    }
    
    const startDate = new Date(this.customStartDate);
    const endDate = new Date(this.customEndDate);
    
    const formatDate = (date: Date) => {
      return date.toLocaleDateString('en-US', { 
        month: 'long', 
        day: 'numeric', 
        year: 'numeric' 
      });
    };
    
    return `${formatDate(startDate)} - ${formatDate(endDate)}`;
  }

  /** Recreate the missing stats document */
  async recreateStatsDocument() {
    try {
      console.log('Recreating missing stats document...');
      await this.firebaseService.recreateStatsDocument();
      console.log('Stats document recreated successfully!');
      
      // Reload the progress data
      await this.loadProgressData();
      console.log('Progress data reloaded');
      
    } catch (error) {
      console.error('Failed to recreate stats document:', error);
    }
  }

  /** Quick fix for missing stats document */
  async quickFixStats() {
    try {
      console.log('Quick fix: Creating stats document...');
      
      // Get existing game records
      const gameRecords = await this.firebaseService.getUserGameSessions();
      console.log('Found', gameRecords.length, 'existing game records');
      
      // Create stats document with current data
      const statsData = {
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
        },
        totalSessions: gameRecords.length
      };
      
      await this.firebaseService.updateUserStats(statsData);
      console.log('Stats document created successfully!');
      
      // Refresh the page data
      await this.loadProgressData();
      console.log('Page refreshed with new stats');
      
    } catch (error) {
      console.error('Quick fix failed:', error);
    }
  }

  /** Debug method to test the new database structure */
  async testNewDatabaseStructure() {
    try {
      console.log('Testing new database structure...');
      
      // Create sample sessions for testing
      const sampleSessions = [
        {
          category: 'people',
          totalQuestions: 10,
          correctAnswers: 8,
          skipped: 1,
          totalTime: 120,
          timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString() // 2 hours ago
        },
        {
          category: 'places',
          totalQuestions: 15,
          correctAnswers: 12,
          skipped: 2,
          totalTime: 180,
          timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString() // 3 days ago
        },
        {
          category: 'objects',
          totalQuestions: 8,
          correctAnswers: 6,
          skipped: 0,
          totalTime: 96,
          timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString() // 1 week ago
        },
        {
          category: 'category-match',
          totalQuestions: 12,
          correctAnswers: 9,
          skipped: 1,
          totalTime: 144,
          timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 1).toISOString() // 1 day ago
        }
      ];

      // Test the calculation methods
      const accuracyOverTime = this.calculateAccuracyOverTime(sampleSessions);
      const avgTimePerCard = this.calculateAvgTimePerCardOverTime(sampleSessions);
      const cardsReviewed = this.calculateCardsReviewedOverTime(sampleSessions);
      const cardsSkipped = this.calculateCardsSkippedOverTime(sampleSessions);

      console.log('Sample calculations:', {
        accuracyOverTime,
        avgTimePerCard,
        cardsReviewed,
        cardsSkipped
      });

      // Test Firebase update
      const statsData = {
        overallStats: {
          accuracy: 78,
          avgTimePerCard: 12,
          totalCards: 45,
          skippedCards: 4
        },
        accuracyOverTime: accuracyOverTime,
        avgTimePerCard: avgTimePerCard,
        cardsReviewed: cardsReviewed,
        cardsSkipped: cardsSkipped,
        recentSessions: sampleSessions
      };

      await this.firebaseService.updateUserStats(statsData);
      console.log('New database structure test completed successfully!');
      
      // Test category records
      await this.firebaseService.updateCategoryRecordsFromSessions(sampleSessions);
      console.log('Category records test completed successfully!');
      
      // Test recent sessions collection
      await this.firebaseService.initializeRecentSessions();
      console.log('Recent sessions collection test completed successfully!');
      
      // Verify category records were created
      const categoryRecords = await this.firebaseService.getCategoryRecords();
      console.log('Category records created:', categoryRecords);
      
      // Verify game records were created
      const gameRecords = await this.firebaseService.getUserGameSessions();
      console.log('Game records created:', gameRecords.length, 'records');
      
      // Verify recent sessions were created
      const recentSessions = await this.firebaseService.getRecentSessions();
      console.log('Recent sessions created:', recentSessions.length, 'records');
      
    } catch (error) {
      console.error('Database structure test failed:', error);
    }
  }
}
