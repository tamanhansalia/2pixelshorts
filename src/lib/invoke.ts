import { invoke as nativeInvoke, type InvokeArgs } from "@tauri-apps/api/core";

/** Tauri Rust Result errors reject with strings, while UI callers use Error.message. */
export async function normalizeIpcError<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(typeof error === "string" ? error : "Native command failed");
  }
}

export const invoke = <T>(command: string, args?: InvokeArgs): Promise<T> =>
  normalizeIpcError(() => nativeInvoke<T>(command, args));
