import { Component, OnInit } from '@angular/core';
import { FirebaseService } from '../../services/firebase.service';
import { Location } from '@angular/common';

@Component({
  selector: 'app-category-performance',
  templateUrl: './category-performance.page.html',
  styleUrls: ['./category-performance.page.scss'],
  standalone: false
})
export class CategoryPerformancePage implements OnInit {
  isLoading = true;
  
  categoryStats: any[] = [
    { name: 'People',        icon: 'person-outline', accuracy: 0, cardsPlayed: 0, avgTime: 0 },
    { name: 'Places',        icon: 'location-outline', accuracy: 0, cardsPlayed: 0, avgTime: 0 },
    { name: 'Objects',       icon: 'cube-outline', accuracy: 0, cardsPlayed: 0, avgTime: 0 },
    { name: 'Category Match',icon: 'extension-puzzle-outline', accuracy: 0, cardsPlayed: 0, avgTime: 0 }
  ];

  constructor(
    private firebaseService: FirebaseService,
    private location: Location
  ) {}

  async ngOnInit() {
    await this.loadCategoryStats();
    this.isLoading = false;
  }

  async loadCategoryStats() {
    try {
      const sessions = await this.firebaseService.getUserGameSessions();
      this.calculateCategoryStats(sessions);
    } catch (error) {
      console.error('Error loading category stats:', error);
      // Fallback to localStorage
      const uid = localStorage.getItem('userId');
      const key = uid ? `gameRecords_${uid}` : 'gameRecords';
      const sessionsData = localStorage.getItem(key);
      if (sessionsData) {
        const sessions = JSON.parse(sessionsData);
        this.calculateCategoryStats(sessions);
      }
    }
  }

  calculateCategoryStats(sessions: any[]) {
    // Reset baseline
    this.categoryStats = [
      { name: 'People',        icon: 'person-outline', accuracy: 0, cardsPlayed: 0, avgTime: 0 },
      { name: 'Places',        icon: 'location-outline', accuracy: 0, cardsPlayed: 0, avgTime: 0 },
      { name: 'Objects',       icon: 'cube-outline', accuracy: 0, cardsPlayed: 0, avgTime: 0 },
      { name: 'Category Match',icon: 'extension-puzzle-outline', accuracy: 0, cardsPlayed: 0, avgTime: 0 }
    ];

    const byName = (name: string) => this.categoryStats.find(c => c.name === name)!;

    const accumulate = (catName: string, sArr: any[]) => {
      if (sArr.length === 0) return;
      let totalQuestions = 0, totalCorrect = 0, totalTime = 0;
      sArr.forEach(s => {
        totalQuestions += s.totalQuestions || 0;
        totalCorrect  += s.correctAnswers || 0;
        totalTime     += s.totalTime || 0;
      });
      const row = byName(catName);
      row.cardsPlayed = totalQuestions;
      row.accuracy = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
      row.avgTime = totalQuestions > 0 ? Math.round(totalTime / totalQuestions) : 0;
    };

    const norm = (s: any) => (s.category || '').toLowerCase().replace(/\s+/g, '-');
    const peopleSessions  = sessions.filter(s => norm(s) === 'people'  || norm(s) === 'name-that-memory-people');
    const placesSessions  = sessions.filter(s => norm(s) === 'places'  || norm(s) === 'name-that-memory-places');
    const objectsSessions = sessions.filter(s => norm(s) === 'objects' || norm(s) === 'name-that-memory-objects');
    const cmSessions      = sessions.filter(s => norm(s) === 'category-match' || norm(s) === 'categorymatch');

    console.log(`📊 Category stats: people=${peopleSessions.length}, places=${placesSessions.length}, objects=${objectsSessions.length}, cm=${cmSessions.length}`);

    accumulate('People', peopleSessions);
    accumulate('Places', placesSessions);
    accumulate('Objects', objectsSessions);
    accumulate('Category Match', cmSessions);
  }

  goBack() {
    this.location.back();
  }
}

