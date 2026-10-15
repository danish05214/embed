import { jobRepository, emptyProgress } from "../repository/jobRepository.js";
import type { JobProgress } from "../types.js";
import { logger } from "../utils/logger.js";

export type JobHandler = (
  report: (p: Partial<JobProgress>) => Promise<void>,
) => Promise<void>;

interface QueuedJob {
  jobId: string;
  handler: JobHandler;
}

class JobQueue {
  private queue: QueuedJob[] = [];
  private running = 0;

  constructor(private readonly concurrency = 1) {}

  enqueue(jobId: string, handler: JobHandler): void {
    this.queue.push({ jobId, handler });
    void this.drain();
  }

  get pending(): number {
    return this.queue.length + this.running;
  }

  private async drain(): Promise<void> {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.running++;
      void this.execute(next).finally(() => {
        this.running--;
        void this.drain();
      });
    }
  }

  private async execute({ jobId, handler }: QueuedJob): Promise<void> {
    const progress: JobProgress = emptyProgress();
    let lastWrite = 0;
    const report = async (p: Partial<JobProgress>) => {
      Object.assign(progress, p);
      if (Date.now() - lastWrite > 1000) {
        lastWrite = Date.now();
        await jobRepository
          .updateProgress(jobId, progress)
          .catch(() => undefined);
      }
    };

    try {
      await jobRepository.markRunning(jobId);
      logger.info("Job started", { jobId });
      await handler(report);
      await jobRepository.finish(jobId, "succeeded", progress);
      logger.info("Job finished", { jobId, progress });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Job failed", { jobId, error: message });
      await jobRepository
        .finish(jobId, "failed", progress, message)
        .catch(() => undefined);
    }
  }
}

export const jobQueue = new JobQueue(1);
