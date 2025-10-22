import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, ToastController } from '@ionic/angular';
import { FirebaseService } from '../../services/firebase.service';
import { Location } from '@angular/common';
import type { Unsubscribe } from '@firebase/firestore';

type UUID = string;

interface UserCategory {
  id: UUID;
  name: string;
  description?: string;
  emoji?: string;
  createdAt: number;
}

const CATEGORIES_KEY = 'alala_custom_categories_v1';

@Component({
  selector: 'app-memory-categories',
  templateUrl: './memory-categories.page.html',
  styleUrls: ['./memory-categories.page.scss'],
  standalone: false
})
export class MemoryCategoriesPage implements OnInit, OnDestroy {
  isPatientMode = false;
  userCategories: UserCategory[] = [];

  constructor(
    private router: Router,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController,
    private firebaseService: FirebaseService,
    private location: Location
  ) {}

  ngOnInit() {
    this.isPatientMode = localStorage.getItem('patientMode') === 'true';
    this.loadCategories();
  }

  ngOnDestroy(): void {
    // Cleanup if needed
  }

  /* ---------------- Categories: add / persist ---------------- */
  async onAddCategory() {
    const alert = await this.alertCtrl.create({
      header: 'New Category',
      message: 'Name your category and optionally add a description.',
      inputs: [
        { name: 'name', type: 'text', placeholder: 'Category name (required)' },
        { name: 'description', type: 'text', placeholder: 'Description (optional)' },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Save',
          handler: (data) => {
            const name = (data?.name || '').trim();
            const description = (data?.description || '').trim();

            if (!name) {
              this.presentToast('Please enter a category name.', 'warning');
              return false;
            }
            if (this.userCategories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
              this.presentToast('Category already exists.', 'warning');
              return false;
            }

            const category: UserCategory = {
              id: this.uuid(),
              name,
              description: description || undefined,
              createdAt: Date.now(),
            };

            this.userCategories.push(category);
            this.saveCategories();

            // Let other pages react live
            window.dispatchEvent(new CustomEvent('categories-updated', { detail: this.userCategories }));

            this.presentToast('Category added', 'success');

            // Navigate to the dedicated empty page for this category
            this.router.navigate(['/category', category.id], {
              state: { categoryName: category.name }
            });

            return true;
          }
        }
      ]
    });
    await alert.present();
  }

  async onRemoveCategory(cat: UserCategory, ev?: Event) {
    // prevent the card click from navigating
    ev?.stopPropagation();
    ev?.preventDefault();

    const alert = await this.alertCtrl.create({
      header: 'Remove Category',
      message: `Remove "${cat.name}"? This will delete the category and all its flashcards.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Remove',
          role: 'destructive',
          handler: async () => {
            try {
              // Delete all flashcards from this category in Firebase
              await this.firebaseService.deleteFlashcardsByCategory(cat.name);
              console.log('Flashcards deleted from Firebase for category:', cat.name);

              // Remove category from local storage
              this.userCategories = this.userCategories.filter(c => c.id !== cat.id);
              this.saveCategories();

              // Clean up local flashcard storage for this category
              const user = this.firebaseService.getCurrentUser();
              const uid = user ? user.uid : 'anon';
              const cardsKey = `alala_cards_${cat.id}_${uid}`;
              localStorage.removeItem(cardsKey);
              console.log('Local flashcard storage cleaned for category:', cat.id);

              this.presentToast('Category and flashcards removed', 'success');
            } catch (err) {
              console.error('Failed to delete category:', err);
              this.presentToast('Failed to remove category. Please try again.', 'danger');
            }
          }
        }
      ]
    });
    await alert.present();
  }

  openCustomCategory(c: UserCategory) {
    this.router.navigate(['/category', c.id], { state: { categoryName: c.name } });
  }

  private loadCategories() {
    try {
      const user = this.firebaseService.getCurrentUser();
      const userSpecificKey = user ? `${CATEGORIES_KEY}_${user.uid}` : CATEGORIES_KEY;
      const raw = localStorage.getItem(userSpecificKey);
      this.userCategories = raw ? (JSON.parse(raw) as UserCategory[]) : [];
    } catch {
      this.userCategories = [];
    }
  }

  private saveCategories() {
    const user = this.firebaseService.getCurrentUser();
    const userSpecificKey = user ? `${CATEGORIES_KEY}_${user.uid}` : CATEGORIES_KEY;
    localStorage.setItem(userSpecificKey, JSON.stringify(this.userCategories));
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

  private uuid(): UUID {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  goBack() {
    this.router.navigate(['/home']);
  }
}
