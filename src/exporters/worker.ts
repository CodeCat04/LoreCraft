/// <reference lib="webworker" />

import { runTask, type TaskMessage, type TaskRequest } from './task';

self.onmessage = (event: MessageEvent<TaskRequest>) => {
  void runTask(event.data, (message: TaskMessage) => self.postMessage(message));
};
