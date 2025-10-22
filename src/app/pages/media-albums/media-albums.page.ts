import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Location } from '@angular/common';

@Component({
  selector: 'app-media-albums',
  templateUrl: './media-albums.page.html',
  styleUrls: ['./media-albums.page.scss'],
  standalone: false
})
export class MediaAlbumsPage implements OnInit {

  constructor(private router: Router, private location: Location) {}

  ngOnInit() {
  }

  goBack() {
    this.location.back();
  }
}
