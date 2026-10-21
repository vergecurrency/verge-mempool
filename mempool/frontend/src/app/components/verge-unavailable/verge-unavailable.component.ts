import { Component } from '@angular/core';

@Component({
  selector: 'app-verge-unavailable',
  standalone: true,
  template: `<div class="container-xl py-4"><h1>Unavailable for Verge</h1>
    <p>This tool is not available on this explorer.</p>
    <p>Search by transaction ID, block hash, block height or public address to explore Verge.</p>
    <a href="/">Return to the explorer</a></div>`,
})
export class VergeUnavailableComponent {}
