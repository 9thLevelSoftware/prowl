import { EventEmitter } from "node:events";

export interface WorkerEvent {
  type: string;
  [k: string]: unknown;
}

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(e: WorkerEvent): void {
  bus.emit("event", { ...e, at: new Date().toISOString() });
}

export function subscribe(fn: (e: WorkerEvent) => void): () => void {
  bus.on("event", fn);
  return () => bus.off("event", fn);
}
