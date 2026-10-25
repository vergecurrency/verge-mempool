import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { ApiService } from '@app/services/api.service';
import { SeoService } from '@app/services/seo.service';
import { VergePeer, VergePeersSnapshot } from '@interfaces/verge.interface';
import { paginateVergePeers, sortVergePeers, VergePeerSortDirection, VergePeerSortKey } from '@app/shared/verge-peers';
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
  sortedPeers: VergePeer[] = [];
  pagePeers: VergePeer[] = [];
  page = 1;
  pageCount = 1;
  pageFrom = 0;
  pageTo = 0;
  sortKey: VergePeerSortKey = 'lastSeen';
  sortDirection: VergePeerSortDirection = 'desc';
  loading = true;
  error = false;
  copiedAddress: string | null = null;
  copyError = false;
  private refreshSubscription?: Subscription;
  private copiedTimer?: ReturnType<typeof setTimeout>;

  constructor(private apiService: ApiService, private seoService: SeoService) {}

  ngOnInit(): void {
    this.seoService.setTitle('Known Verge peers');
    this.seoService.setDescription('Current and previously seen Verge peers, their Core versions and SMSG support.');
    this.refreshSubscription = timer(0, 120000).pipe(
      switchMap(() => this.apiService.getVergePeers$().pipe(
        catchError(() => { this.error = true; return of(null); }),
      )),
    ).subscribe(snapshot => {
      if (snapshot) {
        this.snapshot = snapshot;
        this.sortedPeers = sortVergePeers(snapshot.peers, this.sortKey, this.sortDirection);
        this.showPage(this.page);
        this.error = false;
      }
      this.loading = false;
    });
  }

  ngOnDestroy(): void {
    this.refreshSubscription?.unsubscribe();
    if (this.copiedTimer) { clearTimeout(this.copiedTimer); }
  }

  toIso(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }

  sortBy(key: VergePeerSortKey): void {
    this.sortDirection = this.sortKey === key && this.sortDirection === 'asc' ? 'desc'
      : this.sortKey === key && this.sortDirection === 'desc' ? 'asc'
      : key === 'lastSeen' || key === 'smsgSupport' ? 'desc' : 'asc';
    this.sortKey = key;
    this.sortedPeers = sortVergePeers(this.snapshot?.peers ?? [], key, this.sortDirection);
    this.showPage(1);
  }

  showPage(requestedPage: number): void {
    const result = paginateVergePeers(this.sortedPeers, requestedPage);
    this.pagePeers = result.peers;
    this.page = result.page;
    this.pageCount = result.pageCount;
    this.pageFrom = result.from;
    this.pageTo = result.to;
  }

  ariaSort(key: VergePeerSortKey): string | null {
    return this.sortKey === key ? this.sortDirection === 'asc' ? 'ascending' : 'descending' : null;
  }

  sortIndicator(key: VergePeerSortKey): string {
    return this.sortKey === key ? this.sortDirection === 'asc' ? '▲' : '▼' : '↕';
  }

  async copyPeerAddress(peer: VergePeer): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(peer.address);
      } else {
        const field = document.createElement('textarea');
        field.value = peer.address;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        try {
          field.select();
          if (!document.execCommand('copy')) { throw new Error('Clipboard unavailable'); }
        } finally { field.remove(); }
      }
      this.copiedAddress = peer.address;
      this.copyError = false;
      if (this.copiedTimer) { clearTimeout(this.copiedTimer); }
      this.copiedTimer = setTimeout(() => { this.copiedAddress = null; }, 2000);
    } catch {
      this.copiedAddress = null;
      this.copyError = true;
    }
  }
}
