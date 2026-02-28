export class Metrics {
  private data = new Map<string, number>();

  increment(name: string): void {
    this.data.set(name, (this.data.get(name) ?? 0) + 1);
  }

  gauge(name: string, value: number): void {
    this.data.set(name, value);
  }

  timing(name: string, ms: number): void {
    this.data.set(name, ms);
  }

  getAll(): Record<string, number> {
    return Object.fromEntries(this.data);
  }
}

// Singleton with pre-seeded tracked keys
export const metrics = new Metrics();
metrics.gauge('tasks_submitted', 0);
metrics.gauge('tasks_completed', 0);
metrics.gauge('tasks_failed', 0);
metrics.gauge('tasks_timeout', 0);
metrics.gauge('total_cost_usd', 0);
metrics.gauge('avg_duration_ms', 0);
