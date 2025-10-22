import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Location } from '@angular/common';

@Component({
  selector: 'app-brain-games',
  templateUrl: './brain-games.page.html',
  styleUrls: ['./brain-games.page.scss'],
  standalone: false
})
export class BrainGamesPage implements OnInit {

  constructor(private router: Router, private location: Location) {}

  ngOnInit() {
  }

  goBack() {
    this.location.back();
  }
}
