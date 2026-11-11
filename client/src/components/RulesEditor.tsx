import { useState } from 'react';
import { WandSparkles } from 'lucide-react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { api, money, type CompiledPolicy } from '../api';
import type { Agent, Policy, PolicyCategory } from '../types';
import { categoryLabel, icon } from './ui';

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
    <MetadataList label={{ position: 'start', width: '45%' }}>
      {FIELDS.map(f => (
        <MetadataListItem key={f.label} label={f.label}>
          <Text weight="bold">{f.format(policy)}</Text>
        </MetadataListItem>
      ))}
    </MetadataList>
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
      <TextArea
        label={`${agent.name}'s shopping rules, in your own words`}
        description="One rule per line."
        value={text}
        onChange={value => {
          setText(value);
          setCompiled(null);
        }}
        rows={6}
        width="100%"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          label="Translate rules with AI"
          variant="primary"
          icon={icon(WandSparkles)}
          isLoading={busy === 'compile'}
          isDisabled={rules.length === 0 || (unchanged && !compiled)}
          onClick={compile}
        />
        <Text type="supporting">Claude turns your words into exact limits. You review before anything changes.</Text>
      </div>
      {error && (
        <div className="mt-3" role="alert">
          <Banner status="error" title="Couldn't translate the rules" description={error} />
        </div>
      )}

      {compiled && (
        <div className="mt-4 rounded-md border-2 border-accent bg-accent-muted p-4">
          <p className="font-bold">Here's how the helper will read these rules:</p>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-secondary">
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
                  <tr key={f.label} className={changed ? 'bg-warning-muted text-on-warning-muted' : ''}>
                    <td className="py-1 pr-3 pl-1 text-secondary">{f.label}</td>
                    <td className={`py-1 pr-3 ${changed ? 'line-through opacity-70' : ''}`}>{before}</td>
                    <td className={`py-1 ${changed ? 'font-bold' : ''}`}>{after}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {compiled.proposed.unenforcedRules.length > 0 && (
            <div className="mt-3">
              <Banner
                status="warning"
                title="These can't be enforced automatically yet"
                description={
                  <ul className="list-disc pl-5">
                    {compiled.proposed.unenforcedRules.map(r => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                }
              />
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <Button label="Looks right, save" variant="primary" isLoading={busy === 'save'} onClick={save} />
            <Button label="Cancel" variant="secondary" onClick={() => setCompiled(null)} />
          </div>
        </div>
      )}
    </div>
  );
}
