import { invoke } from '@tauri-apps/api/core';

/** An error from the native side. `code` is stable, `message` is for people. */
export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export async function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  try {
    return await invoke<T>('rpc', { method, params: params ?? null });
  } catch (e) {
    const err = e as { code?: string; message?: string } | string;
    if (typeof err === 'object' && err && err.code) {
      throw new RpcError(err.code, err.message ?? 'Something went wrong.');
    }
    throw new RpcError('UNKNOWN', String(err));
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
