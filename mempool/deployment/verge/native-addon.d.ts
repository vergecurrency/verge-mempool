// Public API of the locked Rust addon in rust/gbt/src.
export interface ThreadTransaction {
  uid: number;
  order: number;
  fee: number;
  weight: number;
  sigops: number;
  effectiveFeePerVsize: number;
  inputs: number[];
}
export interface ThreadAcceleration { uid: number; delta: number; }
export declare class GbtGenerator {
  constructor(maxBlockWeight: number, maxBlocks: number);
  make(mempool: ThreadTransaction[], accelerations: ThreadAcceleration[], maxUid: number): Promise<GbtResult>;
  update(newTxs: ThreadTransaction[], removeTxs: number[], accelerations: ThreadAcceleration[], maxUid: number): Promise<GbtResult>;
}
export declare class GbtResult {
  blocks: number[][];
  blockWeights: number[];
  clusters: number[][];
  rates: number[][];
  overflow: number[];
  constructor(blocks: number[][], blockWeights: number[], clusters: number[][], rates: number[][], overflow: number[]);
}
