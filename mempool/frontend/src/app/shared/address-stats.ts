import type { ChainStats, Transaction, Vout } from '@interfaces/electrs.interface';

/** Mutable address counters for live additions/removals. Coinbase has no prevout,
 * and P2PK outputs are matched by script because they have no address string. */
export class AddressStats implements ChainStats {
  address: string;
  scriptpubkey?: string;
  funded_txo_count: number;
  funded_txo_sum: number;
  spent_txo_count: number;
  spent_txo_sum: number;
  tx_count: number;

  constructor(stats: ChainStats, address: string, scriptpubkey?: string) {
    Object.assign(this, stats);
    this.address = address;
    this.scriptpubkey = scriptpubkey;
  }

  private matches(output?: Vout): boolean {
    return !!output && (output.scriptpubkey_address === this.address
      || (!!this.scriptpubkey && output.scriptpubkey === this.scriptpubkey));
  }

  public addTx(tx: Transaction): void { this.applyTx(tx, 1); }
  public removeTx(tx: Transaction): void { this.applyTx(tx, -1); }

  private applyTx(tx: Transaction, direction: number): void {
    for (const vin of tx.vin) {
      if (this.matches(vin.prevout)) {
        this.spent_txo_sum += direction * vin.prevout.value;
        this.spent_txo_count += direction;
      }
    }
    for (const vout of tx.vout) {
      if (this.matches(vout)) {
        this.funded_txo_sum += direction * vout.value;
        this.funded_txo_count += direction;
      }
    }
    this.tx_count += direction;
  }

  get balance(): number { return this.funded_txo_sum - this.spent_txo_sum; }
  get totalReceived(): number { return this.funded_txo_sum; }
  get utxos(): number { return this.funded_txo_count - this.spent_txo_count; }
}
