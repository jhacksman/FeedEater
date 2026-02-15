declare module "pg" {
  export interface Pool {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
    connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>; release(): void }>;
  }
}
