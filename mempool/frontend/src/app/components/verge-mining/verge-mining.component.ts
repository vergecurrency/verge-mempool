import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { auditTime, catchError, merge, of, shareReplay, switchMap, timer } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';

@Component({
  selector: 'app-verge-mining',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './verge-mining.component.html',
})
export class VergeMiningComponent {
  readonly statistics$ = merge(this.stateService.blocks$, timer(0, 30000)).pipe(
    auditTime(200),
    switchMap(() => this.apiService.getVergeMiningStatistics$().pipe(catchError(() => of(null)))),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  constructor(private apiService: ApiService, private stateService: StateService) {}
}
