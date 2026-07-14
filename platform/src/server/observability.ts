/**
 * Metrics/tracing abstraction. In-process counters and timers behind a sink
 * interface — an OTLP/Prometheus exporter plugs in without touching call
 * sites. Correlation IDs: every request carries x-request-id (inbound value
 * echoed if present, otherwise generated) and it flows into audit events.
 * No metric label ever contains subject refs, tokens or biometric content.
 */
import { randomUUID } from "node:crypto";

export interface MetricsSink {
  increment(name: string, labels?: Record<string, string>): void;
  observe(name: string, valueMs: number, labels?: Record<string, string>): void;
}

class MemorySink implements MetricsSink {
  counters = new Map<string, number>();
  timings = new Map<string, number[]>();

  private key(name: string, labels?: Record<string, string>): string {
    const flat = labels ? Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",") : "";
    return flat ? `${name}{${flat}}` : name;
  }
  increment(name: string, labels?: Record<string, string>) {
    const k = this.key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + 1);
  }
  observe(name: string, valueMs: number, labels?: Record<string, string>) {
    const k = this.key(name, labels);
    const list = this.timings.get(k) ?? [];
    list.push(valueMs);
    this.timings.set(k, list);
  }
  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(
        [...this.timings].map(([k, values]) => [k, {
          count: values.length,
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
        }]),
      ),
    };
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

let sink: MetricsSink & { snapshot?: () => object } = new MemorySink();

export function getMetrics() { return sink; }
export function setMetricsSink(next: MetricsSink) { sink = next; }
export function metricsSnapshot(): object {
  return (sink as MemorySink).snapshot?.() ?? {};
}

/** Times an operation and records outcome-labelled metrics. */
export async function timed<T>(name: string, labels: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    sink.increment(`${name}.ok`, labels);
    return result;
  } catch (err) {
    sink.increment(`${name}.error`, labels);
    throw err;
  } finally {
    sink.observe(`${name}.duration_ms`, performance.now() - start, labels);
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Echo a well-formed inbound x-request-id or mint a new one. */
export function resolveRequestId(inbound: string | null | undefined): string {
  return inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : `req_${randomUUID()}`;
}
