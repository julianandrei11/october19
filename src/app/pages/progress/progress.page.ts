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
  private gameSessionsUnsubscribe?: Unsubscribe;
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
    this.subscribeToGameSessions();

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
      this.subscribeToGameSessions();
    });

    // Listen for game session completion events
    window.addEventListener('game-session-completed', (e: any) => {
      console.log('Progress page: Game session completed event received', e.detail);
      this.handleNewGameSession(e.detail);
    });
  }

  ngOnDestroy() {
    // Clean up subscriptions and intervals
    if (this.gameSessionsUnsubscribe) {
      this.gameSessionsUnsubscribe();
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
        sessions = this.firebaseService.getCachedData('gameSessions', []);
        if (!sessions || sessions.length === 0) {
          // last fallback: user-scoped localStorage key
          const uid = localStorage.getItem('userId');
          const localKey = uid ? `gameSessions:${uid}` : 'gameSessions';
          const raw = localStorage.getItem(localKey) || localStorage.getItem('gameSessions') || '[]';
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
        this.firebaseService.cacheData('gameSessions', sessions);
        
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
      today: calculateAccuracy(todaySessions),
      week: calculateAccuracy(weekSessions),
      month: calculateAccuracy(monthSessions),
      allTime: calculateAccuracy(sessions)
    };
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
      console.log('Calculated accuracy over time:', accuracyOverTime);
      
      const statsData = {
        overallStats: this.overallStats,
        accuracyOverTime: accuracyOverTime
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
        sessions = await this.firebaseService.getUserGameSessions();
        this.isFirebaseConnected = true;
        this.dataSource = 'Firebase';
      } catch (fbErr) {
        console.warn(' Firebase sessions fetch failed; using cached/local sessions', fbErr);
        this.isFirebaseConnected = false;
        sessions = this.firebaseService.getCachedData('gameSessions', []);
        if ((!sessions || sessions.length === 0)) {
          const uid = localStorage.getItem('userId');
          const localKey = uid ? `gameSessions:${uid}` : 'gameSessions';
          const raw = localStorage.getItem(localKey) || '[]';
          try { sessions = JSON.parse(raw); } catch { sessions = []; }
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

          if (!bucketSessions || bucketSessions.length === 0) return 0;
          const totalCorrect = bucketSessions.reduce((sum, s) => sum + (s.correctAnswers || 0), 0);
          const totalQuestions = bucketSessions.reduce((sum, s) => sum + (s.totalQuestions || 0), 0);
          const accuracy = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
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

    // TODAY — show only today's data
if (this.selectedPeriod === 'today') {
  const today = new Date();
  const startDate = new Date(today);
  startDate.setHours(0, 0, 0, 0);
  
  const endDate = new Date(today);
  endDate.setHours(23, 59, 59, 999);

  const key = today.toISOString().split('T')[0];
  const label = today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); // e.g., "Sat, Oct 5"
  
  buckets.push({ key, label, start: startDate, end: endDate });
  return buckets;
}


    // WEEK — show first day when sessions started + 7 days ahead
if (this.selectedPeriod === 'week') {
  if (sessions.length === 0) {
    // No sessions, show empty week
    const today = new Date();
    const startDate = new Date(today);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);
    const key = today.toISOString().split('T')[0];
    const label = today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    buckets.push({ key, label, start: startDate, end: endDate });
    return buckets;
  }

  // Find the earliest session date
  const earliestSession = sessions.reduce((earliest, session) => {
    const sessionDate = new Date(session.timestamp || session.createdAt || 0);
    return sessionDate < earliest ? sessionDate : earliest;
  }, new Date(sessions[0].timestamp || sessions[0].createdAt || 0));

  // Create 8 days starting from the first session day
  for (let i = 0; i < 8; i++) {
    const dayStart = new Date(earliestSession);
    dayStart.setDate(earliestSession.getDate() + i);
    dayStart.setHours(0, 0, 0, 0);
    
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const key = dayStart.toISOString().split('T')[0];
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

  // Find the earliest session date
  const earliestSession = sessions.reduce((earliest, session) => {
    const sessionDate = new Date(session.timestamp || session.createdAt || 0);
    return sessionDate < earliest ? sessionDate : earliest;
  }, new Date(sessions[0].timestamp || sessions[0].createdAt || 0));

  // Create 5 months starting from the first session month
  for (let i = 0; i < 5; i++) {
    const monthStart = new Date(earliestSession.getFullYear(), earliestSession.getMonth() + i, 1, 0, 0, 0, 0);
    const monthEnd = new Date(earliestSession.getFullYear(), earliestSession.getMonth() + i + 1, 0, 23, 59, 59, 999);

    const key = `${monthStart.getFullYear()}-${String(monthStart.getMonth()+1).padStart(2,'0')}`;
    const label = monthStart.toLocaleDateString('en-US', { month: 'short' });
    buckets.push({ key, label, start: monthStart, end: monthEnd });
  }
  return buckets;
}




    // ALL TIME — only show dates where there are actual game sessions
    if (this.selectedPeriod === 'all') {
      // Extract unique dates from sessions
      const sessionDates = new Set<string>();
      sessions.forEach(session => {
        const sessionDate = new Date(session.timestamp || session.createdAt || 0);
        const dateKey = sessionDate.toISOString().split('T')[0];
        sessionDates.add(dateKey);
      });
      
      // Convert to sorted array and create buckets
      const sortedDates = Array.from(sessionDates).sort();
      sortedDates.forEach(dateKey => {
        const date = new Date(dateKey);
        const startDate = new Date(date);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(date);
        endDate.setHours(23, 59, 59, 999);
        
        const label = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        buckets.push({ key: dateKey, label, start: startDate, end: endDate });
      });
      
      console.log(`All Time: Found ${buckets.length} dates with sessions:`, buckets.map(b => b.label));
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
      while (cur <= end) {
        const key = cur.toISOString().split('T')[0];
        const label = cur.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        buckets.push({ key, label, start: new Date(cur), end: new Date(cur.getTime() + 24*3600*1000 - 1) });
        cur.setDate(cur.getDate() + 1);
      }
      return buckets;
    }

    // Default (fallback): produce last 7 days
    {
      for (let i = 6; i >= 0; i--) {
        const dStart = new Date();
        dStart.setDate(dStart.getDate() - i);
        dStart.setHours(0,0,0,0);
        const dEnd = new Date(dStart.getTime() + 24*3600*1000 - 1);
        const key = dStart.toISOString().split('T')[0];
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
      const d = new Date(ts);
      for (const dr of dateRange) {
        if (d >= dr.start && d <= dr.end) {
          map[dr.key].push(s);
          break;
        }
      }
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
    const key = uid ? `gameSessions:${uid}` : 'gameSessions';
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
        allSessions = this.firebaseService.getCachedData('gameSessions', []);
        if ((!allSessions || allSessions.length === 0)) {
          const uid = localStorage.getItem('userId');
          const localKey = uid ? `gameSessions:${uid}` : 'gameSessions';
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

  private subscribeToGameSessions() {
    try {
      // Unsubscribe from previous subscription if exists
      if (this.gameSessionsUnsubscribe) {
        this.gameSessionsUnsubscribe();
      }

      this.gameSessionsUnsubscribe = this.firebaseService.subscribeToGameSessions((sessions) => {
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
        this.firebaseService.cacheData('gameSessions', sessions);
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
    }, 30000); // 30 seconds
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
        sessions = this.firebaseService.getCachedData('gameSessions', []);
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
      this.subscribeToGameSessions();
      
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
}
