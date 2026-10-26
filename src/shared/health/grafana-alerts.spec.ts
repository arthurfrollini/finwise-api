import { z } from 'zod';
import { parse } from 'yaml';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const PROVISIONING = path.join(ROOT, 'docker/grafana/provisioning');

function readYaml(file: string): unknown {
  return parse(fs.readFileSync(path.join(PROVISIONING, file), 'utf8'));
}

// Every finwise_* metric the app registers, as the OTel Prometheus exporter
// names it (monotonic counters get a _total suffix, gauges keep their name).
function exportedMetrics(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const m of source.matchAll(/createCounter\(\s*'([a-z_]+)'/g))
          names.add(`${m[1]}_total`);
        for (const m of source.matchAll(
          /createObservableGauge\(\s*'([a-z_]+)'/g,
        ))
          if (m[1]) names.add(m[1]);
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return names;
}

const datasources = z
  .object({
    datasources: z.array(z.object({ name: z.string(), uid: z.string() })),
  })
  .parse(readYaml('datasources/datasources.yml'));

const alerting = z
  .object({
    contactPoints: z.array(
      z.object({
        name: z.string(),
        receivers: z.array(
          z.object({
            type: z.string(),
            settings: z.object({ addresses: z.string() }),
          }),
        ),
      }),
    ),
    policies: z.array(z.object({ receiver: z.string() })),
    groups: z.array(
      z.object({
        name: z.string(),
        rules: z.array(
          z.object({
            uid: z.string(),
            title: z.string(),
            for: z.string(),
            labels: z.object({ severity: z.enum(['critical', 'warning']) }),
            annotations: z.object({ summary: z.string() }),
            data: z.array(
              z.object({
                datasourceUid: z.string(),
                model: z.object({ expr: z.string().optional() }),
              }),
            ),
          }),
        ),
      }),
    ),
  })
  .parse(readYaml('alerting/alerting.yml'));

const rules = alerting.groups.flatMap((g) => g.rules);
const exprs = rules.flatMap((r) =>
  r.data.flatMap((d) => (d.model.expr === undefined ? [] : [d.model.expr])),
);

describe('Grafana alerting', () => {
  it('emails the address from ALERT_EMAIL, so no inbox is committed', () => {
    const [contactPoint] = alerting.contactPoints;
    const receivers = (contactPoint?.receivers ?? []).map((r) => [
      r.type,
      r.settings.addresses,
    ]);
    expect(receivers).toEqual([['email', '$ALERT_EMAIL']]);
    expect(alerting.policies[0]?.receiver).toBe(contactPoint?.name);
  });

  it('only queries metrics the app actually exports', () => {
    const exported = exportedMetrics();
    const used = new Set(
      exprs.flatMap((e) => e.match(/finwise_[a-z_]+/g) ?? []),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const metric of used) expect(exported).toContain(metric);
  });

  it('only points at datasources that are provisioned', () => {
    const known = new Set([
      ...datasources.datasources.map((d) => d.uid),
      '__expr__',
    ]);
    for (const rule of rules)
      for (const d of rule.data) expect(known).toContain(d.datasourceUid);
  });

  it('covers a dead dependency, an unreachable API, 5xx, and AI failures and spend', () => {
    const all = exprs.join('\n');
    for (const fragment of [
      'finwise_dependency_up',
      'up{job="finwise-api"}',
      'http_response_status_code=~"5.."',
      'finwise_llm_requests_total{outcome!="ok"}',
      'finwise_llm_cost_usd_total',
    ]) {
      expect(all).toContain(fragment);
    }
  });

  it('gives every rule a unique uid', () => {
    const uids = rules.map((r) => r.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });
});
