import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { ApiService } from '@app/services/api.service';
import { SeoService } from '@app/services/seo.service';
import { VergePeersSnapshot } from '@interfaces/verge.interface';
import { Subscription, catchError, of, switchMap, timer } from 'rxjs';

@Component({
  selector: 'app-verge-peers',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './verge-peers.component.html',
  styleUrls: ['./verge-peers.component.scss'],
})
export class VergePeersComponent implements OnInit, OnDestroy {
  snapshot: VergePeersSnapshot | null = null;
  loading = true;
  error = false;
  private refreshSubscription?: Subscription;

  constructor(private apiService: ApiService, private seoService: SeoService) {}

  ngOnInit(): void {
    this.seoService.setTitle('Connected Verge peers');
    this.seoService.setDescription('Connected Verge peers and their advertised Core versions.');
    this.refreshSubscription = timer(0, 15000).pipe(
      switchMap(() => this.apiService.getVergePeers$().pipe(
        catchError(() => { this.error = true; return of(null); }),
      )),
    ).subscribe(snapshot => {
      if (snapshot) { this.snapshot = snapshot; this.error = false; }
      this.loading = false;
    });
  }

  ngOnDestroy(): void {
    this.refreshSubscription?.unsubscribe();
  }

  toIso(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }
}
