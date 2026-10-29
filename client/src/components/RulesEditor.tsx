import { useState } from 'react';
import { TriangleAlert, WandSparkles } from 'lucide-react';
import { api, money, type CompiledPolicy } from '../api';
import type { Agent, Policy, PolicyCategory } from '../types';
import { Button, categoryLabel } from './ui';

const list = (cats: PolicyCategory[]) => (cats.length ? cats.map(categoryLabel).join(', ') : '—');

const FIELDS: Array<{ label: string; format: (p: Policy) => string }> = [
  { label: 'Weekly budget', format: p => money(p.weeklyBudget) },
  { label: 'Buys on its own up to', format: p => money(p.approvalAbove) },
  { label: 'Never above', format: p => money(p.perItemMax) },
  { label: 'Usual categories', format: p => (p.allowedCategories.length ? list(p.allowedCategories) : 'Any not blocked') },
  { label: 'Always ask first', format: p => list(p.approvalCategories) },
  { label: 'Never buy', format: p => list(p.blockedCategories) },
  { label: 'Trusted stores', format: p => p.trustedMerchants.join(', ') || '—' },
  { label: 'New stores', format: p => (p.newMerchantNeedsApproval ? 'Ask first' : 'Allowed') },
  { label: 'Minimum rating', format: p => (p.minRating ? `${p.minRating}★` : '—') }
];

export function PolicySummary({ policy }: { policy: Policy }) {
  return (
    <dl className="grid grid-cols-1 gap-y-2 text-sm">
      {FIELDS.map(f => (
        <div key={f.label} className="flex justify-between gap-3 border-b border-line/70 pb-1.5">
          <dt className="text-muted">{f.label}</dt>
          <dd className="text-right font-bold">{f.format(policy)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RulesEditor({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const [text, setText] = useState(agent.semanticRules.join('\n'));
  const [compiled, setCompiled] = useState<CompiledPolicy | null>(null);
  const [busy, setBusy] = useState<'compile' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rules = text.split('\n').map(r => r.trim()).filter(Boolean);
  const unchanged = rules.join('\n') === agent.semanticRules.join('\n');

  const compile = async () => {
    setBusy('compile');
    setError(null);
    try {
      setCompiled(await api.compilePolicy(agent.id, rules));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!compiled) return;
    setBusy('save');
    try {
      await api.savePolicy(agent.id, compiled.rules, compiled.proposed);
      setCompiled(null);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <label htmlFor="rules" className="font-bold">
        {agent.name}'s shopping rules, in your own words (one per line)
      </label>
      <textarea
        id="rules"
        value={text}
        onChange={e => {
          setText(e.target.value);
          setCompiled(null);
        }}
        rows={6}
        className="mt-2 w-full rounded-xl border border-line bg-paper p-3 leading-relaxed outline-none focus:border-brand"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button onClick={compile} busy={busy === 'compile'} disabled={rules.length === 0 || (unchanged && !compiled)}>
          <WandSparkles className="h-4 w-4" /> Translate rules with AI
        </Button>
        <span className="text-sm text-muted">Gemini turns your words into exact limits. You review before anything changes.</span>
      </div>
      {error && <p className="mt-2 text-danger">{error}</p>}

      {compiled && (
        <div className="mt-4 rounded-xl border-2 border-brand/40 bg-brand-soft/50 p-4">
          <p className="font-bold">Here's how the helper will read these rules:</p>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="pb-1 font-normal"> </th>
                <th className="pb-1 font-normal">Now</th>
                <th className="pb-1 font-normal">After saving</th>
              </tr>
            </thead>
            <tbody>
              {FIELDS.map(f => {
                const before = f.format(compiled.current);
                const after = f.format(compiled.proposed);
                const changed = before !== after;
                return (
                  <tr key={f.label} className={changed ? 'bg-hold-soft' : ''}>
                    <td className="py-1 pr-3 text-muted">{f.label}</td>
                    <td className={`py-1 pr-3 ${changed ? 'text-muted line-through' : ''}`}>{before}</td>
                    <td className={`py-1 ${changed ? 'font-bold' : ''}`}>{after}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {compiled.proposed.unenforcedRules.length > 0 && (
            <div className="mt-3 flex gap-2 rounded-lg bg-hold-soft p-3 text-sm text-hold">
              <TriangleAlert className="h-5 w-5 shrink-0" />
              <div>
                <p className="font-bold">These can't be enforced automatically yet:</p>
                <ul className="list-disc pl-5">
                  {compiled.proposed.unenforcedRules.map(r => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <Button variant="ok" onClick={save} busy={busy === 'save'}>
              Looks right, save
            </Button>
            <Button variant="secondary" onClick={() => setCompiled(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
