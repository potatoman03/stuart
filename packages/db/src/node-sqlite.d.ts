declare module "node:sqlite" {
  export type SQLInputValue = string | number | bigint | Uint8Array | null;
  export type SQLOutputValue = string | number | bigint | Uint8Array | null;
  export interface StatementResultingChanges {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    run(...params: SQLInputValue[]): StatementResultingChanges;
    run(
      namedParameters: Record<string, SQLInputValue>,
      ...anonymousParameters: SQLInputValue[]
    ): StatementResultingChanges;
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
