import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { FirebaseService } from '../../services/firebase.service';

@Component({
  selector: 'app-patient-details',
  templateUrl: './patient-details.page.html',
  styleUrls: ['./patient-details.page.scss'],
  standalone: false
})
export class PatientDetailsPage implements OnInit {
  patientName: string = '';
  patientAge: string = '';
  patientSex: string = '';
  isLoading: boolean = false;
  userId: string = '';

  constructor(
    private router: Router,
    private firebaseService: FirebaseService
  ) {}

  ngOnInit() {
    // Get the user ID from localStorage
    this.userId = localStorage.getItem('userId') || '';
    if (!this.userId) {
      alert('User ID not found. Please sign up again.');
      this.router.navigate(['/signup']);
    }
  }

  async savePatientDetails() {
    // Trim whitespace
    const name = (this.patientName || '').trim();
    const age = (this.patientAge || '').toString().trim();
    const sex = (this.patientSex || '').trim();

    // Validate all fields are filled
    if (!name) {
      alert('Please enter the patient\'s name');
      return;
    }

    if (!age) {
      alert('Please enter the patient\'s age');
      return;
    }

    if (!sex) {
      alert('Please select the patient\'s sex');
      return;
    }

    // Validate age is a number
    const ageNum = parseInt(age, 10);
    if (isNaN(ageNum) || ageNum < 0 || ageNum > 150) {
      alert('Please enter a valid age (0-150)');
      return;
    }

    this.isLoading = true;

    try {
      // Save patient details to Firestore
      const patientDetails = {
        name: name,
        age: ageNum,
        sex: sex
      };

      // Add to Firestore using the existing savePatientDetails method
      await this.firebaseService.savePatientDetails(patientDetails);

      // Store in localStorage as well for quick access
      localStorage.setItem('patientDetails', JSON.stringify(patientDetails));

      // Redirect to home page
      this.router.navigate(['/home']);

    } catch (error: any) {
      console.error('Error saving patient details:', error);
      alert(error.message || 'Failed to save patient details. Please try again.');
    } finally {
      this.isLoading = false;
    }
  }

  goBack() {
    this.router.navigate(['/signup']);
  }
}

